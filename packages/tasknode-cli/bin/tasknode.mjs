#!/usr/bin/env node
// tasknode: connect every coding agent on this machine to Task Node with one
// device sign-in. Single file, Node 18+ built-ins only, so the curl installer
// can download and run it as is. Tokens go straight into agent config files
// (mode 600) and are never printed.
import { execFile, spawn } from "node:child_process";
import {
  accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const VERSION = "0.1.0";
const DEFAULT_SERVER = "https://tasknode.postfiat.org";
const SERVER_NAME = "tasknode";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{8,512}$/;

const HELP = `tasknode ${VERSION}: connect your coding agents to Task Node

Usage:
  tasknode connect [--agent claude,codex] [--scope local] [--yes] [--server URL]
  tasknode status        Show which account each agent is on
  tasknode disconnect    Remove Task Node from your agents and revoke their tokens

Options:
  --agent LIST     Only these agents: claude, codex, hermes, pi, opencode, kilo, cursor, gemini
  --scope local    Claude Code only: connect this folder and leave the rest of the machine as is
  --yes, -y        Replace a connection to another account without asking
  --server URL     Task Node server (default ${DEFAULT_SERVER}, or $TASKNODE_URL)
  --no-browser     Print the sign-in link without opening a browser
  --status         Same as tasknode status
  --disconnect     Same as tasknode disconnect
  --help, --version`;

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

// Node 18 prints an ExperimentalWarning the first time fetch is used.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (String(warning?.message ?? warning).includes("Fetch API") ? undefined : emitWarning(warning, ...rest));

// ---------------------------------------------------------------------------
// Output. Every token the CLI sees is registered here and scrubbed from
// anything it prints, including error text from agent CLIs.

const secrets = new Set();
const remember = (token) => {
  if (token) secrets.add(token);
  return token;
};
function redact(text) {
  let out = String(text ?? "");
  for (const secret of secrets) out = out.split(secret).join("<token>");
  return out.replace(/tns_[A-Za-z0-9._~+/=-]+/g, "tns_…");
}
const say = (line = "") => process.stdout.write(`${redact(line)}\n`);
const warn = (line) => process.stderr.write(`${redact(line)}\n`);
const printable = (value) => String(value ?? "").replace(/[^\x20-\x7e\u00a0-\uffff]/g, "");
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const listNames = (names) => (names.length < 2 ? names[0] || "" : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const attempt = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------------------
// Files.

const home = () => os.homedir();
const expandHome = (value) => (value === "~" || value.startsWith("~/") ? path.join(home(), value.slice(1)) : value);
const envDir = (name, fallback) => (process.env[name] ? path.resolve(expandHome(process.env[name])) : fallback);
const tilde = (file) => (file.startsWith(home() + path.sep) ? `~${file.slice(home().length)}` : file);
const dirExists = (dir) => attempt(() => statSync(dir).isDirectory(), false);

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

// Atomic replace: write a 0600 temp file next to the target, then rename.
// Symlinked dotfiles are followed so the link itself survives.
function writePrivate(file, content) {
  const target = attempt(() => realpathSync(file), file);
  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, target);
  } catch (error) {
    attempt(() => unlinkSync(temp));
    if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
    writeFileSync(target, content, { mode: 0o600 });
  }
}

const isExecutable = (file) => attempt(() => {
  if (!statSync(file).isFile()) return false;
  if (process.platform !== "win32") accessSync(file, constants.X_OK);
  return true;
}, false);
function onPath(name) {
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const file = exts.map((ext) => path.join(dir, name + ext.toLowerCase())).find(isExecutable);
    if (file) return file;
  }
  return null;
}

// Runs an agent CLI without a shell (Windows .cmd shims excepted). The token
// is in argv for the life of the call, as with those agents' own `mcp add`.
function run(file, args) {
  if (!file) return Promise.reject(new Error("command not found"));
  return new Promise((resolve, reject) => {
    const batch = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
    const child = execFile(batch ? `"${file}"` : file, batch ? args.map((arg) => `"${arg}"`) : args, {
      shell: batch, timeout: 120_000, windowsHide: true, maxBuffer: 1 << 22,
    }, (error, stdout, stderr) => {
      if (!error) return resolve();
      const detail = String(stderr || stdout || error.message).trim().split(/\r?\n/).slice(-2).join(" ");
      reject(new Error(`${path.basename(file)} ${args.slice(0, 2).join(" ")} failed${detail ? `: ${detail}` : ""}`));
    });
    child.stdin?.end();
  });
}

// ---------------------------------------------------------------------------
// JSON and JSONC, edited in place: only the touched member changes, so key
// order, indentation, comments and the trailing newline survive.

function parseJsonc(text) {
  let i = 0;
  const bad = () => {
    throw new Error(`invalid JSON near offset ${i}`);
  };
  const space = () => {
    for (;;) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\ufeff") i++;
      else if (c === "/" && text[i + 1] === "/") while (i < text.length && text[i] !== "\n") i++;
      else if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) bad();
        i = end + 2;
      } else return;
    }
  };
  const string = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (i >= text.length) bad();
    i++;
    // JSON.parse errors quote the input, which may be a token: report the offset only.
    return attempt(() => JSON.parse(text.slice(start, i)), undefined) ?? bad();
  };
  const literal = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const value = (depth) => {
    if (depth > 256) bad();
    space();
    const start = i;
    if (text[i] === "{") {
      i++;
      const node = { type: "object", start, members: [], value: {} };
      space();
      while (text[i] !== "}") {
        if (text[i] !== '"') bad();
        const keyStart = i;
        const key = string();
        space();
        if (text[i++] !== ":") bad();
        const child = value(depth + 1);
        node.members.push({ key, keyStart, node: child });
        Object.defineProperty(node.value, key, { value: child.value, enumerable: true, writable: true, configurable: true });
        space();
        if (text[i] === ",") {
          i++;
          space();
        } else if (text[i] !== "}") bad();
      }
      node.end = ++i;
      return node;
    }
    if (text[i] === "[") {
      i++;
      const node = { type: "array", start, value: [] };
      space();
      while (text[i] !== "]") {
        node.value.push(value(depth + 1).value);
        space();
        if (text[i] === ",") {
          i++;
          space();
        } else if (text[i] !== "]") bad();
      }
      node.end = ++i;
      return node;
    }
    if (text[i] === '"') {
      const parsed = string();
      return { type: "value", start, end: i, value: parsed };
    }
    literal.lastIndex = i;
    const match = literal.exec(text);
    if (!match) bad();
    i += match[0].length;
    return { type: "value", start, end: i, value: JSON.parse(match[0]) };
  };
  const root = value(0);
  space();
  if (i < text.length) bad();
  return root;
}

const splice = (text, start, end, insert) => text.slice(0, start) + insert + text.slice(end);
const lineLead = (text, pos) => /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", pos - 1) + 1, pos))[0];
const render = (value, unit, indent, pretty) => (pretty ? JSON.stringify(value, null, unit).replace(/\n/g, `\n${indent}`) : JSON.stringify(value));

// Sets (or, with value undefined, deletes) the member at `keys`.
function editJson(text, keys, value) {
  if (value === undefined && !text.trim()) return text;
  const source = text.trim() ? text : "{}\n";
  const root = parseJsonc(source);
  if (root.type !== "object") throw new Error("expected a JSON object");
  const fallbackUnit = /\n([ \t]+)\S/.exec(source)?.[1] || "  ";
  // One indent step: a member's indent minus its object's, else the file's first.
  const unitOf = (object) => {
    const outer = lineLead(source, object.start);
    const inner = object.members.length ? lineLead(source, object.members[0].keyStart) : "";
    return inner.length > outer.length && inner.startsWith(outer) ? inner.slice(outer.length) : fallbackUnit;
  };
  let node = root;
  for (let depth = 0; depth < keys.length; depth++) {
    const key = keys[depth];
    const last = depth === keys.length - 1;
    const member = node.members.findLast((entry) => entry.key === key);
    if (value === undefined) {
      if (!member || (!last && member.node.type !== "object")) return text;
      if (!last) {
        node = member.node;
        continue;
      }
      const list = node.members;
      const index = list.indexOf(member);
      if (list.length === 1) return splice(source, node.start + 1, node.end - 1, "");
      if (index < list.length - 1) return splice(source, member.keyStart, list[index + 1].keyStart, "");
      return splice(source, list[index - 1].node.end, member.node.end, "");
    }
    if (member && !last && member.node.type === "object") {
      node = member.node;
      continue;
    }
    const nested = keys.slice(depth + 1).reduceRight((inner, name) => ({ [name]: inner }), value);
    const unit = unitOf(node);
    const pretty = node.members.length ? source.slice(node.start, node.end).includes("\n") : source.includes("\n");
    if (member) {
      return splice(source, member.node.start, member.node.end, render(nested, unit, lineLead(source, member.keyStart), pretty));
    }
    const name = JSON.stringify(key);
    if (!node.members.length) {
      const outer = lineLead(source, node.start);
      const inner = pretty ? `\n${outer}${unit}${name}: ${render(nested, unit, outer + unit, true)}\n${outer}` : `${name}:${render(nested)}`;
      return splice(source, node.start + 1, node.end - 1, inner);
    }
    const indent = lineLead(source, node.members[0].keyStart);
    const after = node.members.at(-1).node.end;
    return splice(source, after, after, pretty ? `,\n${indent}${name}: ${render(nested, unit, indent, true)}` : `,${name}:${render(nested)}`);
  }
  return source;
}

function readJson(file) {
  const text = readText(file);
  return text?.trim() ? attempt(() => parseJsonc(text).value, null) : null;
}

const unparsable = (file) => new Error(`could not parse ${tilde(file)}; left it unchanged`);

function editJsonFile(file, keys, value) {
  const text = readText(file) ?? "";
  const next = attempt(() => editJson(text, keys, value), null);
  if (next === null) throw unparsable(file);
  writePrivate(file, next);
}

// Deletes every copy of the member (JSON allows duplicate keys).
function removeJsonFile(file, keys) {
  const text = readText(file);
  if (text === null) return false;
  const next = attempt(() => {
    let current = text;
    for (let pass = editJson(current, keys); pass !== current; pass = editJson(current, keys)) current = pass;
    return current;
  }, null);
  if (next === null) throw unparsable(file);
  if (next === text) return false;
  writePrivate(file, next);
  return true;
}

const dig = (value, keys) => keys.reduce((node, key) => (node && typeof node === "object" && Object.hasOwn(node, key) ? node[key] : undefined), value);

// ---------------------------------------------------------------------------
// TOML (Codex). Finds [a.b] tables, their [a.b.*] subtables and dotted keys
// in parent tables, skipping multi-line strings, and replaces only those lines.

function tomlKeyPath(line, start) {
  const keys = [];
  let i = start;
  for (;;) {
    while (line[i] === " " || line[i] === "\t") i++;
    if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') j += line[j] === "\\" ? 2 : 1;
      const key = j < line.length ? attempt(() => JSON.parse(line.slice(i, j + 1)), null) : null;
      if (key === null) return null;
      keys.push(key);
      i = j + 1;
    } else if (line[i] === "'") {
      const j = line.indexOf("'", i + 1);
      if (j < 0) return null;
      keys.push(line.slice(i + 1, j));
      i = j + 1;
    } else {
      const bare = /[A-Za-z0-9_-]+/y;
      bare.lastIndex = i;
      const match = bare.exec(line);
      if (!match) return null;
      keys.push(match[0]);
      i += match[0].length;
    }
    while (line[i] === " " || line[i] === "\t") i++;
    if (line[i] !== ".") return { keys, end: i };
    i++;
  }
}

function tomlHeader(line) {
  const text = line.trimStart();
  if (!text.startsWith("[")) return null;
  const array = text.startsWith("[[");
  const parsed = tomlKeyPath(text, array ? 2 : 1);
  const close = array ? "]]" : "]";
  if (!parsed || !text.startsWith(close, parsed.end)) return null;
  const rest = text.slice(parsed.end + close.length).trim();
  return rest && !rest.startsWith("#") ? null : { keys: parsed.keys, array };
}

function multilineAfter(line, open) {
  let state = open;
  for (let i = 0; i < line.length;) {
    if (state) {
      const end = line.indexOf(state, i);
      if (end < 0) return state;
      i = end + 3;
      state = null;
    } else if (line[i] === "#") return null;
    else if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      state = line.slice(i, i + 3);
      i += 3;
    } else if (line[i] === '"') {
      i++;
      while (i < line.length && line[i] !== '"') i += line[i] === "\\" ? 2 : 1;
      i++;
    } else if (line[i] === "'") {
      const end = line.indexOf("'", i + 1);
      i = end < 0 ? line.length : end + 1;
    } else i++;
  }
  return state;
}

const startsWithKeys = (keys, prefix) => prefix.every((key, index) => keys[index] === key);
const isBlank = (line) => !line.trim();
const isBlankOrComment = (line) => /^\s*(#.*)?$/.test(line);

function tomlFind(text, target) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const sections = [{ start: 0, keys: [], header: false, array: false }];
  const inString = [];
  let open = null;
  lines.forEach((line, index) => {
    inString[index] = Boolean(open);
    const header = open ? null : tomlHeader(line);
    if (header) sections.push({ start: index, ...header, header: true });
    open = multilineAfter(line, open);
  });
  const ranges = [];
  sections.forEach((section, index) => {
    const end = index + 1 < sections.length ? sections[index + 1].start : lines.length;
    if (section.header && section.keys.length >= target.length && startsWithKeys(section.keys, target)) {
      // Trailing comments belong to the next table; blank lines go with this one.
      let stop = end;
      while (stop > section.start + 1 && isBlankOrComment(lines[stop - 1])) stop--;
      while (stop < end && isBlank(lines[stop])) stop++;
      ranges.push({ start: section.start, end: stop, table: true });
    } else if (!section.array && target.length > section.keys.length && startsWithKeys(target, section.keys)) {
      for (let n = section.start + (section.header ? 1 : 0); n < end; n++) {
        const parsed = inString[n] ? null : tomlKeyPath(lines[n], 0);
        if (!parsed || lines[n][parsed.end] !== "=") continue;
        const full = [...section.keys, ...parsed.keys];
        if (full.length >= target.length && startsWithKeys(full, target)) ranges.push({ start: n, end: n + 1, table: false });
      }
    }
  });
  const snippet = ranges.map((range) => lines.slice(range.start, range.end).join("\n")).join("\n");
  return { eol, lines, ranges, snippet };
}

// Replaces the table in place (or appends it); body null removes it.
function tomlSetTable(text, target, body) {
  const { eol, lines, ranges } = tomlFind(text, target);
  const block = body && [`[${target.map((key) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key))).join(".")}]`, ...body];
  const byStart = new Map(ranges.map((range) => [range.start, range]));
  const out = [];
  let placed = !block;
  for (let n = 0; n < lines.length;) {
    const range = byStart.get(n);
    if (!range) {
      out.push(lines[n++]);
      continue;
    }
    if (!placed && range.table) {
      out.push(...block);
      if (range.end < lines.length) out.push("");
      placed = true;
    }
    n = range.end;
  }
  if (!placed) {
    while (out.length && isBlank(out.at(-1))) out.pop();
    if (out.length) out.push("");
    out.push(...block);
  }
  while (out.length && isBlank(out.at(-1))) out.pop();
  return out.length ? out.join(eol) + eol : "";
}

// ---------------------------------------------------------------------------
// Agents. Each one can detect itself, read its current Task Node entry, write
// the same entry its own `mcp add` command produces, and remove it.

const NONE = Object.freeze({ configured: false, token: null, url: null });
const found = (url, token) => ({ configured: true, url: typeof url === "string" ? url : null, token: remember(token) || null });

function bearer(value) {
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(typeof value === "string" ? value : "");
  if (!match) return null;
  const ref = /^(?:\$\{(\w+)\}|\{env:(\w+)\})$/.exec(match[1]);
  return ref ? process.env[ref[1] || ref[2]] || null : match[1];
}

function entryFrom(value, urlKey = "url") {
  if (!value || typeof value !== "object") return NONE;
  const headers = value.headers && typeof value.headers === "object" ? value.headers : {};
  return found(value[urlKey] ?? value.url, bearer(headers.Authorization ?? headers.authorization));
}

function dotenv(text) {
  const values = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

// Lines of `parent: { child: ... }` in a block-style YAML document.
function yamlBlock(text, parent, child) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const top = lines.findIndex((line) => new RegExp(`^${parent}\\s*:\\s*(#.*)?$`).test(line));
  if (top < 0) return null;
  const block = [];
  let base = -1;
  for (const line of lines.slice(top + 1)) {
    if (isBlankOrComment(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;
    if (base >= 0) {
      if (indent <= base) break;
      block.push(line);
    } else if (new RegExp(`^\\s*["']?${child}["']?\\s*:`).test(line)) {
      base = indent;
      block.push(line);
    }
  }
  return base >= 0 ? block.join("\n") : null;
}

// Claude Code keys local-scope servers by the project's git root (the main
// checkout for worktrees), else by the folder itself.
function claudeProjectKey(cwd) {
  const dir = attempt(() => realpathSync(cwd), path.resolve(cwd));
  let key = dir;
  for (let current = dir; ; current = path.dirname(current)) {
    const dotGit = path.join(current, ".git");
    const stat = attempt(() => statSync(dotGit), null);
    if (stat) {
      key = stat.isFile() ? worktreeRoot(current, dotGit) : current;
      break;
    }
    if (path.dirname(current) === current) break;
  }
  return process.platform === "win32" ? key.replaceAll("\\", "/") : key;
}

function worktreeRoot(dir, dotGit) {
  return attempt(() => {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!gitdir) return dir;
    const resolved = path.resolve(dir, gitdir);
    const common = path.resolve(resolved, readFileSync(path.join(resolved, "commondir"), "utf8").trim());
    if (path.dirname(resolved) !== path.join(common, "worktrees")) return dir;
    return path.basename(common) === ".git" ? path.dirname(common) : common;
  }, dir);
}

const claudeFile = () => path.join(envDir("CLAUDE_CONFIG_DIR", home()), ".claude.json");
const codexFile = () => path.join(envDir("CODEX_HOME", path.join(home(), ".codex")), "config.toml");
const hermesHome = () => envDir("HERMES_HOME", path.join(home(), ".hermes"));
const piFile = () => path.join(envDir("PI_CODING_AGENT_DIR", path.join(home(), ".pi", "agent")), "mcp.json");
const xdgConfig = () => envDir("XDG_CONFIG_HOME", path.join(home(), ".config"));
const bearerHeader = (token) => ({ Authorization: `Bearer ${token}` });
const userKeys = ["mcpServers", SERVER_NAME];
const localKeys = (ctx) => ["projects", claudeProjectKey(ctx.cwd), "mcpServers", SERVER_NAME];

// What `claude mcp add --scope local` creates for a folder Claude Code has not seen yet.
const CLAUDE_PROJECT_DEFAULTS = {
  allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false,
};

const claude = {
  id: "claude",
  name: "Claude Code",
  label: (ctx) => (ctx.scope === "local" ? "Claude Code (this folder)" : "Claude Code"),
  detect: () => Boolean(onPath("claude")) || existsSync(claudeFile()) || dirExists(path.join(home(), ".claude")),
  read: (ctx) => entryFrom(dig(readJson(claudeFile()), ctx.scope === "local" ? localKeys(ctx) : userKeys)),
  entries(ctx) {
    const doc = readJson(claudeFile());
    const local = { label: "Claude Code (this folder)", ...entryFrom(dig(doc, localKeys(ctx))) };
    if (ctx.scope === "local") return [local];
    return [{ label: "Claude Code", ...entryFrom(dig(doc, userKeys)) }, ...(local.configured ? [local] : [])];
  },
  async write(ctx, url, token) {
    const entry = { type: "http", url, headers: bearerHeader(token) };
    if (ctx.scope !== "local") return editJsonFile(claudeFile(), userKeys, entry);
    const key = claudeProjectKey(ctx.cwd);
    const project = dig(readJson(claudeFile()), ["projects", key]);
    if (project && typeof project === "object" && !Array.isArray(project)) return editJsonFile(claudeFile(), localKeys(ctx), entry);
    return editJsonFile(claudeFile(), ["projects", key], { ...CLAUDE_PROJECT_DEFAULTS, mcpServers: { [SERVER_NAME]: entry } });
  },
  async remove(ctx) {
    const local = removeJsonFile(claudeFile(), localKeys(ctx));
    return (ctx.scope !== "local" && removeJsonFile(claudeFile(), userKeys)) || local;
  },
  tokens() {
    const doc = readJson(claudeFile());
    const projects = Object.values(doc?.projects && typeof doc.projects === "object" ? doc.projects : {});
    return [dig(doc, userKeys), ...projects.map((project) => dig(project, ["mcpServers", SERVER_NAME]))].map((entry) => entryFrom(entry).token);
  },
};

const codex = {
  id: "codex",
  name: "Codex",
  detect: () => Boolean(onPath("codex")) || Boolean(process.env.CODEX_HOME) || dirExists(path.join(home(), ".codex")),
  read() {
    const text = readText(codexFile());
    if (text === null) return NONE;
    const { ranges, snippet } = tomlFind(text, ["mcp_servers", SERVER_NAME]);
    if (!ranges.length) return NONE;
    const envVar = /bearer_token_env_var\s*=\s*["']([^"']+)["']/.exec(snippet)?.[1];
    const token = /["']?Authorization["']?\s*=\s*["']Bearer\s+([^"'\s]+)["']/i.exec(snippet)?.[1] || (envVar && process.env[envVar]);
    return found(/\burl\s*=\s*["']([^"']+)["']/.exec(snippet)?.[1], token);
  },
  async write(ctx, url, token) {
    const body = [`url = ${JSON.stringify(url)}`, `http_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }`];
    writePrivate(codexFile(), tomlSetTable(readText(codexFile()) ?? "", ["mcp_servers", SERVER_NAME], body));
  },
  async remove() {
    const text = readText(codexFile());
    if (text === null || !tomlFind(text, ["mcp_servers", SERVER_NAME]).ranges.length) return false;
    writePrivate(codexFile(), tomlSetTable(text, ["mcp_servers", SERVER_NAME], null));
    return true;
  },
};

const hermes = {
  id: "hermes",
  name: "Hermes",
  detect: () => Boolean(onPath("hermes")),
  read() {
    const block = yamlBlock(readText(path.join(hermesHome(), "config.yaml")), "mcp_servers", SERVER_NAME);
    if (block === null) return NONE;
    const raw = /Authorization["']?\s*:\s*["']?Bearer\s+([^\s"'#,}]+)/i.exec(block)?.[1] || null;
    const ref = /^\$\{(\w+)\}$/.exec(raw || "");
    const token = ref ? dotenv(readText(path.join(hermesHome(), ".env")))[ref[1]] || process.env[ref[1]] : raw;
    return found(/\burl["']?\s*:\s*["']?([^\s"'#,}]+)/.exec(block)?.[1], token);
  },
  async write(ctx, url, token) {
    const bin = onPath("hermes");
    await run(bin, ["config", "set", "MCP_TASKNODE_API_KEY", token]);
    await run(bin, ["config", "set", "--force", "mcp_servers.tasknode.url", url]);
    await run(bin, ["config", "set", "--force", "mcp_servers.tasknode.headers.Authorization", "Bearer ${MCP_TASKNODE_API_KEY}"]);
  },
  async remove() {
    if (!hermes.read().configured) return false;
    const bin = onPath("hermes");
    await run(bin, ["config", "unset", "mcp_servers.tasknode"]);
    await run(bin, ["config", "unset", "MCP_TASKNODE_API_KEY"]).catch(() => {});
    return true;
  },
};

const pi = {
  id: "pi",
  name: "Pi",
  detect: () => Boolean(onPath("pi")),
  read: () => entryFrom(dig(readJson(piFile()), userKeys)),
  async write(ctx, url, token) {
    const bin = onPath("pi");
    if (pi.read().configured) await run(bin, ["mcp", "remove", SERVER_NAME]).catch(() => {});
    await run(bin, ["mcp", "add", SERVER_NAME, "--url", url, "--header", `Authorization=Bearer ${token}`, "--exposure", "direct"]);
  },
  async remove() {
    if (!pi.read().configured) return false;
    await run(onPath("pi"), ["mcp", "remove", SERVER_NAME]);
    return true;
  },
};

// OpenCode and Kilo: `mcp add` replaces an existing entry; neither has
// `mcp remove`, so disconnect edits their global config file directly.
function openCodeAgent(id, name, files) {
  const configFiles = () => files.map((file) => path.join(xdgConfig(), id, file));
  const entries = () => configFiles().map((file) => entryFrom(dig(readJson(file), ["mcp", SERVER_NAME])));
  return {
    id,
    name,
    detect: () => Boolean(onPath(id)),
    read: () => entries().find((entry) => entry.configured) || NONE,
    tokens: () => entries().map((entry) => entry.token),
    async write(ctx, url, token) {
      await run(onPath(id), ["mcp", "add", SERVER_NAME, "--url", url, "--header", `Authorization=Bearer ${token}`]);
    },
    async remove() {
      return configFiles().map((file) => removeJsonFile(file, ["mcp", SERVER_NAME])).some(Boolean);
    },
  };
}

function jsonFileAgent({ id, name, file, urlKey, detect }) {
  return {
    id,
    name,
    detect,
    read: () => entryFrom(dig(readJson(file()), userKeys), urlKey),
    async write(ctx, url, token) {
      editJsonFile(file(), userKeys, { [urlKey]: url, headers: bearerHeader(token) });
    },
    async remove() {
      return removeJsonFile(file(), userKeys);
    },
  };
}

const AGENTS = [
  claude,
  codex,
  hermes,
  pi,
  openCodeAgent("opencode", "OpenCode", ["opencode.json", "opencode.jsonc", "config.json"]),
  openCodeAgent("kilo", "Kilo", ["kilo.jsonc", "kilo.json", "opencode.jsonc", "opencode.json", "config.json"]),
  jsonFileAgent({
    id: "cursor", name: "Cursor", urlKey: "url",
    file: () => path.join(home(), ".cursor", "mcp.json"),
    detect: () => dirExists(path.join(home(), ".cursor")),
  }),
  jsonFileAgent({
    id: "gemini", name: "Gemini CLI", urlKey: "httpUrl",
    file: () => path.join(home(), ".gemini", "settings.json"),
    detect: () => dirExists(path.join(home(), ".gemini")) || Boolean(onPath("gemini")),
  }),
];
for (const agent of AGENTS) {
  agent.label ??= () => agent.name;
  agent.entries ??= (ctx) => [{ label: agent.label(ctx), ...agent.read(ctx) }];
  agent.tokens ??= () => [agent.read({ scope: "user", cwd: process.cwd() }).token];
}
const ALIASES = { "claude-code": "claude", "gemini-cli": "gemini", kilocode: "kilo", "kilo-code": "kilo" };
const SUPPORTED = AGENTS.map((agent) => agent.name).join(", ");

const safeRead = (agent, ctx) => attempt(() => agent.read(ctx), NONE);
// Every token any agent config on this machine still references, in any scope.
const tokensInUse = () => new Set(AGENTS.flatMap((agent) => attempt(() => agent.tokens(), [])).filter(Boolean));

// ---------------------------------------------------------------------------
// Task Node API: device authorization (RFC 8628), whoami, revoke.

async function api(origin, pathname, { method = "GET", token, json, form } = {}) {
  const headers = { accept: "application/json", "user-agent": `tasknode-cli/${VERSION}` };
  let body;
  if (token) headers.authorization = `Bearer ${token}`;
  if (json) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  if (form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  }
  const response = await fetch(`${origin}${pathname}`, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(20_000) });
  const data = await response.json().catch(() => null);
  return { status: response.status, data: data && typeof data === "object" ? data : {} };
}

async function apiRetry(origin, pathname, options, tries = 3) {
  for (let n = 1; ; n++) {
    try {
      return await api(origin, pathname, options);
    } catch (error) {
      if (n >= tries) throw error;
      await sleep(750 * n);
    }
  }
}

const whoamiCache = new Map();
function whoami(origin, token) {
  const key = `${origin} ${token}`;
  if (!whoamiCache.has(key)) {
    whoamiCache.set(key, apiRetry(origin, "/api/agent/whoami", { token }, 2).then(({ status, data }) => {
      if (status === 200 && data.account && typeof data.account === "object") return { status: "ok", account: data.account };
      return { status: status === 401 || status === 403 ? "invalid" : "unreachable" };
    }, () => ({ status: "unreachable" })));
  }
  return whoamiCache.get(key);
}

async function revoke(origin, token) {
  try {
    const { status } = await apiRetry(origin, "/api/auth/terminal/revoke", { method: "POST", token, json: {} }, 2);
    return status === 200 || status === 401;
  } catch {
    return false;
  }
}

const accountName = (account) => printable(account?.handle || account?.github || account?.displayName || account?.accountId || "your account");
const walletNote = (account) => (account?.walletShort ? ` (wallet ${printable(account.walletShort)})` : "");
const sameAccount = (a, b) => (a?.accountId && b?.accountId ? a.accountId === b.accountId : accountName(a) === accountName(b));
const originOf = (url) => attempt(() => new URL(url).origin, null);
const httpUrl = (value) => attempt(() => (/^https?:$/.test(new URL(value).protocol) ? printable(value) : null), null);

function openBrowser(url) {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT) return;
  let command;
  if (process.platform === "darwin") command = ["open", [url]];
  else if (process.platform === "win32") command = ["cmd", ["/c", "start", '""', `"${url}"`]];
  else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) command = ["xdg-open", [url]];
  else return;
  // Failure is fine: the printed link is enough.
  attempt(() => {
    const child = spawn(command[0], command[1], { stdio: "ignore", detached: true, windowsHide: true, windowsVerbatimArguments: true });
    child.on("error", () => {});
    child.unref();
  });
}

async function signIn(origin, agents, opts) {
  let start;
  try {
    start = await apiRetry(origin, "/oauth/device_authorization", {
      method: "POST",
      json: { client_name: "tasknode-cli", client_version: VERSION, device_name: os.hostname(), platform: process.platform, agents: agents.map((agent) => agent.id) },
    });
  } catch {
    throw new CliError(`Could not reach ${origin}. Check the connection and try again.`);
  }
  const grant = start.data;
  if (start.status !== 200 || typeof grant.device_code !== "string" || typeof grant.user_code !== "string") {
    throw new CliError(`Sign-in could not start (${printable(grant.error_description || grant.error || `HTTP ${start.status}`)}).`);
  }
  const code = printable(grant.user_code);
  const uri = httpUrl(grant.verification_uri) || `${origin}/activate`;
  const complete = httpUrl(grant.verification_uri_complete) || `${uri}?code=${encodeURIComponent(code)}`;
  say(`To connect, open  ${uri}  and enter  ${code}`);
  say(`(or open ${complete})`);
  say("Waiting for approval…");
  if (opts.browser) openBrowser(complete);
  return pollForToken(origin, grant);
}

async function pollForToken(origin, grant) {
  let interval = Number(grant.interval);
  if (!Number.isFinite(interval) || interval < 0) interval = 5;
  const deadline = Date.now() + (Number(grant.expires_in) > 0 ? Number(grant.expires_in) : 600) * 1000;
  let offline = false;
  while (Date.now() < deadline) {
    await sleep(Math.min(interval * 1000, Math.max(0, deadline - Date.now())));
    let response;
    try {
      response = await api(origin, "/oauth/token", { method: "POST", form: { grant_type: DEVICE_GRANT, device_code: grant.device_code } });
    } catch {
      if (!offline) say("Lost the connection to Task Node; retrying…");
      offline = true;
      continue;
    }
    offline = false;
    const { status, data } = response;
    if (status === 200 && typeof data.access_token === "string") return data;
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") {
      interval += 5;
      continue;
    }
    if (data.error === "expired_token") throw new CliError("The code expired. Run tasknode connect again.");
    if (data.error === "access_denied") throw new CliError("Sign-in was declined. Nothing changed.");
    if (data.error === "invalid_grant") throw new CliError("That code is no longer valid. Run tasknode connect again.");
    if (status === 429 || status >= 500) {
      if (status === 429) interval += 5;
      continue;
    }
    throw new CliError(`Sign-in failed (${printable(data.error_description || data.error || `HTTP ${status}`)}).`);
  }
  throw new CliError(offline ? `Lost the connection to ${origin} and the code expired. Run tasknode connect again.` : "The code expired. Run tasknode connect again.");
}

// ---------------------------------------------------------------------------
// Commands.

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on("SIGINT", () => {
      process.stdout.write("\n");
      process.exit(130);
    });
    rl.on("close", () => {
      if (answered) return;
      process.stdout.write("\n");
      resolve(false);
    });
    rl.question(`${question} [y/N] `, (answer) => {
      answered = true;
      rl.close();
      resolve(/^\s*y(es)?\s*$/i.test(answer));
    });
  });
}

function context(opts) {
  return { scope: opts.scope, cwd: process.cwd(), origin: serverOrigin(opts) };
}

function selectAgents(opts) {
  if (opts.scope === "local") {
    if (opts.agents?.some((id) => id !== "claude")) throw new CliError("--scope local works with Claude Code only.", 2);
    return [claude];
  }
  if (!opts.agents) return AGENTS;
  const unknown = opts.agents.filter((id) => !AGENTS.some((agent) => agent.id === id));
  if (unknown.length) throw new CliError(`Unknown agent "${unknown[0]}". Supported: ${AGENTS.map((agent) => agent.id).join(", ")}.`, 2);
  return AGENTS.filter((agent) => opts.agents.includes(agent.id));
}

function serverOrigin(opts) {
  const raw = String(opts.server || process.env.TASKNODE_URL || DEFAULT_SERVER).trim();
  const origin = originOf(raw.includes("://") ? raw : `https://${raw}`);
  if (!origin || !/^https?:\/\//.test(origin)) throw new CliError(`Not a valid server URL: ${raw}`, 2);
  return origin;
}

// Decides, per agent, whether to write: new and same-account entries are
// written; another account's entry needs a yes.
async function planWrites(agents, before, { ctx, token, account, name, opts }) {
  const plan = new Map();
  const questions = new Map();
  for (const agent of agents) {
    const prior = before.get(agent);
    if (!prior.configured || prior.token === token) {
      plan.set(agent, { write: true });
      continue;
    }
    const priorOrigin = originOf(prior.url) || ctx.origin;
    const who = prior.token ? await whoami(priorOrigin, prior.token) : { status: "unknown" };
    const old = { oldToken: prior.token, oldOrigin: priorOrigin };
    if (who.status === "invalid") plan.set(agent, { write: true });
    else if (who.status === "ok" && sameAccount(who.account, account)) plan.set(agent, { write: true, ...old });
    else {
      const label = who.status === "ok" ? accountName(who.account) : "";
      plan.set(agent, { write: false, label, ...old });
      questions.set(label, [...(questions.get(label) || []), agent]);
    }
  }
  let declined = false;
  const invocation = process.env.TASKNODE_INVOCATION || "npx -y tasknode connect";
  for (const [label, group] of questions) {
    const subject = `${listNames(group.map((agent) => agent.label(ctx)))} ${group.length > 1 ? "are" : "is"} ${label ? `connected as ${label}` : "already connected (account unknown)"}`;
    const offerLocal = group.includes(claude) && ctx.scope !== "local";
    let replace = false;
    if (opts.yes) {
      say(`${subject}. Replacing with ${name}.`);
      replace = true;
    } else if (!process.stdin.isTTY) {
      say(`${subject}. Left as is: no terminal to confirm. Re-run with --yes to replace${offerLocal ? ", or with --scope local to use this folder only" : ""}.`);
    } else {
      if (offerLocal) say(`Or keep ${label || "it"} and use ${name} in this folder only (Claude Code): answer N, then run ${invocation} --scope local`);
      replace = await ask(`${subject}. Replace with ${name}?`);
      declined ||= !replace;
    }
    for (const agent of group) if (replace) plan.get(agent).write = true;
  }
  return { plan, declined };
}

async function connect(opts) {
  const ctx = context(opts);
  const wanted = selectAgents(opts);
  const agents = wanted.filter((agent) => agent.detect());
  const missing = opts.agents ? wanted.filter((agent) => !agents.includes(agent)) : [];
  if (!agents.length) {
    const what = opts.agents ? `${listNames(wanted.map((agent) => agent.name))} not found` : "No supported agent found";
    throw new CliError(`${what}. Supported: ${SUPPORTED}. Install one, then run this again.`);
  }
  const before = new Map(agents.map((agent) => [agent, safeRead(agent, ctx)]));
  const grant = await signIn(ctx.origin, agents, opts);
  const token = remember(grant.access_token);
  if (!TOKEN_SHAPE.test(token)) throw new CliError("The server returned an unusable token. Nothing changed.");
  const account = grant.account && typeof grant.account === "object" ? grant.account : (await whoami(ctx.origin, token)).account || {};
  const name = accountName(account);
  const { plan, declined } = await planWrites(agents, before, { ctx, token, account, name, opts });

  const results = [];
  for (const agent of agents) {
    const step = plan.get(agent);
    if (!step.write) {
      results.push({ agent, mark: "–", note: step.label ? `kept ${step.label}` : "kept" });
      continue;
    }
    try {
      await agent.write(ctx, `${ctx.origin}/mcp`, token);
      results.push({ agent, mark: "✓", step });
    } catch (error) {
      results.push({ agent, mark: "✗", note: "failed", error });
    }
  }

  const written = results.filter((result) => result.mark === "✓");
  const superseded = new Map();
  for (const { step } of written) if (step.oldToken && step.oldToken !== token) superseded.set(step.oldToken, step.oldOrigin);
  const inUse = tokensInUse();
  let revoked = 0;
  for (const [old, oldOrigin] of superseded) if (!inUse.has(old) && (await revoke(oldOrigin, old))) revoked++;
  if (!written.length) await revoke(ctx.origin, token);

  say(written.length ? `Connected as ${name}${walletNote(account)}` : `Signed in as ${name}${walletNote(account)}. No agent changed.`);
  const marks = results.map(({ agent, mark, note }) => `${mark} ${agent.label(ctx)}${note ? ` (${note})` : ""}`);
  say(`  ${[...marks, ...missing.map((agent) => `– ${agent.name} (not installed)`)].join("   ")}`);
  for (const { agent, error } of results) if (error) warn(`${agent.label(ctx)}: ${error.message}`);
  if (revoked) say(`Revoked ${plural(revoked, "old token")}.`);
  if (written.length) {
    say(written.some((result) => result.agent === claude) ? "Restart running agents, or run /mcp in Claude Code, to pick it up." : "Restart running agents to pick it up.");
  }
  if (results.some((result) => result.error)) return 1;
  return written.length || declined ? 0 : 1;
}

async function describe(entry, origin) {
  if (!entry.configured) return "not connected";
  if (!entry.token) return "connected (account unknown)";
  const entryOrigin = originOf(entry.url) || origin;
  const where = entryOrigin === origin ? "" : ` on ${new URL(entryOrigin).host}`;
  const who = await whoami(entryOrigin, entry.token);
  if (who.status === "ok") return `${accountName(who.account)}${walletNote(who.account)}${where}`;
  if (who.status === "invalid") return `token no longer valid${where}; run tasknode connect`;
  return `connected (could not reach ${new URL(entryOrigin).host})`;
}

async function status(opts) {
  const ctx = context(opts);
  const agents = selectAgents(opts).filter((agent) => agent.detect());
  if (!agents.length) {
    say(`No supported agent found. Supported: ${SUPPORTED}.`);
    return 0;
  }
  const rows = [];
  for (const agent of agents) {
    let entries;
    try {
      entries = agent.entries(ctx);
    } catch (error) {
      rows.push([agent.label(ctx), `config unreadable (${error.message})`]);
      continue;
    }
    for (const entry of entries) rows.push([entry.label, await describe(entry, ctx.origin)]);
  }
  const width = Math.max(...rows.map(([label]) => label.length)) + 3;
  for (const [label, text] of rows) say(`${label.padEnd(width)}${text}`);
  return 0;
}

async function disconnect(opts) {
  const ctx = context(opts);
  const agents = selectAgents(opts).filter((agent) => agent.detect());
  const removed = [];
  const failures = [];
  const tokens = new Map();
  for (const agent of agents) {
    try {
      const entries = agent.entries(ctx).filter((entry) => entry.configured);
      if (!entries.length || !(await agent.remove(ctx))) continue;
      removed.push(agent);
      for (const entry of entries) if (entry.token) tokens.set(entry.token, originOf(entry.url) || ctx.origin);
    } catch (error) {
      failures.push([agent, error]);
    }
  }
  if (!removed.length && !failures.length) {
    say("Nothing to disconnect.");
    return 0;
  }
  const inUse = tokensInUse();
  let revoked = 0;
  let failed = 0;
  for (const [token, origin] of tokens) {
    if (inUse.has(token)) continue;
    if (await revoke(origin, token)) revoked++;
    else failed++;
  }
  if (removed.length) say(`Disconnected ${listNames(removed.map((agent) => agent.name))}.`);
  for (const [agent, error] of failures) warn(`${agent.name}: ${error.message}`);
  if (revoked) say(`Revoked ${plural(revoked, "token")}.`);
  if (failed) say(`Could not revoke ${plural(failed, "token")}. Sign out agents at ${ctx.origin}/connect to be sure.`);
  return failures.length || failed ? 1 : 0;
}

function parseArgs(argv) {
  const opts = { command: null, agents: null, scope: "user", yes: false, server: null, browser: !process.env.TASKNODE_NO_BROWSER };
  let positional = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const value = () => {
      const next = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (!next) throw new CliError(`${flag} needs a value.`, 2);
      return next;
    };
    if (flag === "--help" || flag === "-h" || (!positional && flag === "help")) return { ...opts, command: "help" };
    if (flag === "--version" || flag === "-v" || flag === "-V") return { ...opts, command: "version" };
    if (flag === "--agent" || flag === "--agents") {
      opts.agents = value().split(",").map((id) => id.trim().toLowerCase()).filter(Boolean).map((id) => ALIASES[id] || id);
      if (!opts.agents.length) throw new CliError("--agent needs at least one agent.", 2);
    } else if (flag === "--scope") {
      opts.scope = value().toLowerCase();
      if (!["user", "local"].includes(opts.scope)) throw new CliError("--scope is user (default) or local.", 2);
    } else if (flag === "--server") opts.server = value();
    else if (flag === "--yes" || flag === "-y") opts.yes = true;
    else if (flag === "--no-browser") opts.browser = false;
    else if (flag === "--status") opts.command = "status";
    else if (flag === "--disconnect") opts.command = "disconnect";
    else if (!positional && ["connect", "status", "disconnect"].includes(flag)) positional = flag;
    else throw new CliError(`Unknown ${flag.startsWith("-") ? "option" : "command"}: ${flag}`, 2);
  }
  return { ...opts, command: opts.command || positional || "help" };
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.command === "help") {
    say(HELP);
    return 0;
  }
  if (opts.command === "version") {
    say(VERSION);
    return 0;
  }
  return { connect, status, disconnect }[opts.command](opts);
}

const finish = (code) => process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
main(process.argv.slice(2)).then(finish, (error) => {
  if (error instanceof CliError) {
    warn(error.message);
    if (error.code === 2) warn("Run tasknode --help for usage.");
    return finish(error.code);
  }
  warn(`tasknode: ${error?.message || error}`);
  return finish(1);
});
