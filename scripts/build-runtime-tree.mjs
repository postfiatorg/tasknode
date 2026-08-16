#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const importPatterns = [
  /(?:^|\n)\s*(?:import|export)\s+[\s\S]*?\s+from\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function packageName(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function resolveLocalImport(importer, specifier) {
  const unresolved = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    unresolved,
    `${unresolved}.js`,
    `${unresolved}.mjs`,
    `${unresolved}.json`,
    path.join(unresolved, "index.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) || "";
}

function normalizedRepoPath(absolutePath) {
  const relative = path.relative(repoRoot, absolutePath).replaceAll(path.sep, "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`runtime_file_outside_repository:${absolutePath}`);
  }
  return relative;
}

export function runtimeGraph(entryPaths = []) {
  const files = new Set();
  const packages = new Set();
  const missing = [];

  function visit(absolutePath) {
    const file = path.resolve(absolutePath);
    if (files.has(file)) return;
    normalizedRepoPath(file);
    files.add(file);
    if (path.extname(file) === ".json") return;
    const source = readFileSync(file, "utf8");
    for (const pattern of importPatterns) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier.startsWith("node:")) continue;
        if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
          const dependency = packageName(specifier);
          if (dependency) packages.add(dependency);
          continue;
        }
        const resolved = resolveLocalImport(file, specifier);
        if (!resolved) missing.push({ importer: normalizedRepoPath(file), specifier });
        else visit(resolved);
      }
    }
  }

  for (const entryPath of entryPaths) {
    const entry = path.resolve(repoRoot, entryPath);
    if (!existsSync(entry) || !statSync(entry).isFile()) throw new Error(`runtime_entry_missing:${entryPath}`);
    visit(entry);
  }

  return {
    files: [...files].map(normalizedRepoPath).sort(),
    packages: [...packages].sort(),
    missing,
  };
}

function repeatedArgument(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

function copyEntry(source, output, excludes = []) {
  const absoluteSource = path.resolve(repoRoot, source);
  if (!existsSync(absoluteSource)) throw new Error(`runtime_include_missing:${source}`);
  const destination = path.join(output, source);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(absoluteSource, destination, {
    recursive: true,
    filter(candidate) {
      const relative = normalizedRepoPath(candidate);
      return !excludes.some((excluded) => relative === excluded || relative.startsWith(`${excluded}/`));
    },
  });
}

function buildRuntimeTree() {
  const entries = repeatedArgument("--entry");
  const includes = repeatedArgument("--include");
  const excludes = repeatedArgument("--exclude").map((value) => value.replaceAll("\\", "/").replace(/\/$/, ""));
  const outputArg = repeatedArgument("--out").at(-1) || "";
  if (!entries.length || !outputArg) throw new Error("usage: --entry <file> [--entry <file>] --out <directory>");
  const output = path.resolve(outputArg);
  if ([repoRoot, path.parse(output).root].includes(output)) throw new Error(`unsafe_runtime_output:${output}`);

  const graph = runtimeGraph(entries);
  if (graph.missing.length) throw new Error(`runtime_local_import_missing:${JSON.stringify(graph.missing)}`);
  mkdirSync(output, { recursive: true });
  for (const file of graph.files) copyEntry(file, output, excludes);
  for (const include of includes) copyEntry(include, output, excludes);
  writeFileSync(path.join(output, "RUNTIME-MANIFEST.json"), `${JSON.stringify({ entries, ...graph }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, output, entries, files: graph.files.length, packages: graph.packages }));
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) buildRuntimeTree();
