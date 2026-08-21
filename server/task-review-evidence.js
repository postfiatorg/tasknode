import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  GIST_EXCERPT_MAX_CHARS,
  GIST_MAX_FILES,
  TASK_REVIEW_USER_AGENT,
  URL_EXCERPT_MAX_CHARS,
  URL_FETCH_TIMEOUT_MS,
  URL_REDIRECT_MAX_HOPS,
  safeArray,
  safeObject,
  safeText,
  sha256,
} from "./task-review-core.js";

export function hostnameValue(value = "") {
  return safeText(value, 260).toLowerCase().replace(/^\[|\]$/g, "");
}

export function isPrivateIpv4(address = "") {
  const parts = String(address || "").split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPrivateIpv6(address = "") {
  const normalized = hostnameValue(address);
  if (!normalized || normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }
  if (normalized.startsWith("ff")) return true;
  const mappedIpv4 = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false;
}

export function isPrivateIpAddress(address = "") {
  const family = isIP(hostnameValue(address));
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return false;
}

export function isSafeEvidenceUrlLiteral(url = "") {
  try {
    const parsed = new URL(safeText(url, 1000));
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { ok: false, reason: "unsupported_protocol" };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, reason: "credentials_not_allowed" };
    }
    const hostname = hostnameValue(parsed.hostname);
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
      return { ok: false, reason: "localhost_not_allowed" };
    }
    if (isIP(hostname) && isPrivateIpAddress(hostname)) {
      return { ok: false, reason: "private_ip_not_allowed" };
    }
    return { ok: true, url: parsed };
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
}

export async function resolveSafeEvidenceUrl(url = "", { lookupFn = lookup } = {}) {
  const literal = isSafeEvidenceUrlLiteral(url);
  if (!literal.ok) return literal;
  const hostname = hostnameValue(literal.url.hostname);
  if (!isIP(hostname)) {
    try {
      const addresses = await lookupFn(hostname, { all: true });
      if (!addresses.length) return { ok: false, reason: "dns_no_addresses" };
      if (addresses.some((entry) => isPrivateIpAddress(entry.address))) {
        return { ok: false, reason: "dns_private_ip_not_allowed" };
      }
    } catch {
      return { ok: false, reason: "dns_lookup_failed" };
    }
  }
  return literal;
}

export function headerValue(headers, name) {
  const getter = headers?.get;
  return typeof getter === "function" ? safeText(getter.call(headers, name) || "", 2000) : "";
}

export function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
      const codepoint = Number.parseInt(hex, 16);
      return Number.isFinite(codepoint) && codepoint >= 0 && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : "";
    })
    .replace(/&#(\d+);/g, (_match, decimal) => {
      const codepoint = Number.parseInt(decimal, 10);
      return Number.isFinite(codepoint) && codepoint >= 0 && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : "";
    });
}

export function collapseWhitespace(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function stripHtmlToText(html = "") {
  const withoutBoilerplate = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template\s*>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav\s*>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header\s*>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer\s*>/gi, " ")
    .replace(/<form\b[\s\S]*?<\/form\s*>/gi, " ")
    .replace(/<title\b[\s\S]*?<\/title\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return collapseWhitespace(decodeHtmlEntities(withoutBoilerplate));
}

export function extractHtmlTitle(html = "") {
  const raw = String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || "";
  return safeText(collapseWhitespace(decodeHtmlEntities(raw.replace(/<[^>]+>/g, " "))), 300);
}

export function isHtmlResponse(response, text = "") {
  const contentType = headerValue(response?.headers, "content-type").toLowerCase();
  if (contentType.includes("text/html") || contentType.includes("application/xhtml")) return true;
  if (contentType) return false;
  return /^\s*<!doctype html\b/i.test(text) || /^\s*<html\b/i.test(text);
}

export async function fetchOnceWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      ...options,
      headers: {
        "user-agent": TASK_REVIEW_USER_AGENT,
        ...(options.headers || {}),
      },
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timerId);
  }
}

export async function fetchWithSafeRedirects(url = "", {
  fetchImpl = fetch,
  lookupFn = lookup,
  maxRedirects = URL_REDIRECT_MAX_HOPS,
} = {}) {
  const value = safeText(url, 1000);
  let safety = await resolveSafeEvidenceUrl(value, { lookupFn });
  if (!safety.ok) {
    return {
      status: "blocked",
      url: value,
      error: safety.reason || "evidence_url_not_allowed",
    };
  }

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetchOnceWithTimeout(fetchImpl, safety.url.href);
    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers, "location");
      if (!location) {
        return {
          status: "redirect_not_followed",
          url: safety.url.href,
          http_status: response.status,
          location: "",
        };
      }
      if (hop >= maxRedirects) {
        return {
          status: "too_many_redirects",
          url: safety.url.href,
          http_status: response.status,
          location,
        };
      }
      const redirectTarget = new URL(location, safety.url.href).href;
      const nextSafety = await resolveSafeEvidenceUrl(redirectTarget, { lookupFn });
      if (!nextSafety.ok) {
        return {
          status: "blocked",
          url: redirectTarget,
          http_status: response.status,
          error: nextSafety.reason || "evidence_url_not_allowed",
        };
      }
      safety = nextSafety;
      continue;
    }
    return {
      status: "fetched",
      url: safety.url.href,
      response,
    };
  }

  return {
    status: "too_many_redirects",
    url: safety.url.href,
  };
}

export async function responseExcerpt({ response, url, sourceUrl = "" } = {}) {
  const text = await response.text();
  const html = isHtmlResponse(response, text);
  const title = html ? extractHtmlTitle(text) : "";
  const excerpt = html
    ? safeText(stripHtmlToText(text), URL_EXCERPT_MAX_CHARS)
    : safeText(text, URL_EXCERPT_MAX_CHARS);
  return {
    status: response.ok ? "extracted" : "http_error",
    url,
    ...(sourceUrl && sourceUrl !== url ? { source_url: sourceUrl } : {}),
    http_status: response.status,
    title,
    excerpt,
  };
}

export function parseGistUrl(url = "") {
  try {
    const parsed = new URL(safeText(url, 1000));
    if (hostnameValue(parsed.hostname) !== "gist.github.com") return null;
    const [user, id] = parsed.pathname.split("/").filter(Boolean);
    if (!user || !id) return null;
    return { user, id };
  } catch {
    return null;
  }
}

export async function gistApiExcerpt({ id, sourceUrl, fetchImpl, lookupFn }) {
  const apiUrl = `https://api.github.com/gists/${encodeURIComponent(id)}`;
  const fetched = await fetchWithSafeRedirects(apiUrl, { fetchImpl, lookupFn });
  if (fetched.status !== "fetched") return fetched;
  const bodyText = await fetched.response.text();
  if (!fetched.response.ok) {
    return {
      status: "http_error",
      url: fetched.url,
      source_url: sourceUrl,
      http_status: fetched.response.status,
      title: "",
      excerpt: safeText(bodyText, URL_EXCERPT_MAX_CHARS),
    };
  }
  try {
    const body = JSON.parse(bodyText);
    const allFiles = Object.values(safeObject(body.files))
      .filter((file) => typeof file?.content === "string")
      .sort((left, right) => {
        const priority = (file) => /^(?:readme)(?:\.|$)|\.(?:md|markdown|txt|rst|adoc)$/i.test(file?.filename || "") ? 0 : 1;
        return priority(left) - priority(right) || String(left?.filename || "").localeCompare(String(right?.filename || ""));
      });
    const files = allFiles.slice(0, GIST_MAX_FILES);
    const minimumPerFile = Math.max(250, Math.floor(GIST_EXCERPT_MAX_CHARS / Math.max(files.length, 1) / 2));
    const allocations = files.map((file) => Math.min(String(file.content || "").length, minimumPerFile));
    let remaining = Math.max(0, GIST_EXCERPT_MAX_CHARS - allocations.reduce((total, value) => total + value, 0) - files.length * 40);
    for (let index = 0; index < files.length && remaining > 0; index += 1) {
      const available = Math.max(0, String(files[index].content || "").length - allocations[index]);
      const grant = Math.min(available, remaining);
      allocations[index] += grant;
      remaining -= grant;
    }
    const sections = files.map((file, index) => {
      const filename = safeText(file?.filename || "gist-file", 160);
      const content = String(file?.content || "");
      const included = allocations[index];
      return [
        `FILE: ${filename} | original_chars=${content.length} | included_chars=${included}`,
        content.slice(0, included),
        included < content.length ? `[truncated omitted_chars=${content.length - included}]` : "",
      ].filter(Boolean).join("\n");
    });
    const excerpt = [
      `GIST MANIFEST: ${files.length} text file(s) included${allFiles.length > files.length ? `, ${allFiles.length - files.length} file(s) omitted by safety limit` : ""}`,
      ...sections,
    ].join("\n\n");
    return {
      status: "extracted",
      url: fetched.url,
      source_url: sourceUrl,
      http_status: fetched.response.status,
      title: safeText(body.description || `GitHub Gist ${id}`, 300),
      excerpt: safeText(excerpt, GIST_EXCERPT_MAX_CHARS),
      file_count: files.length,
      omitted_file_count: Math.max(0, allFiles.length - files.length),
    };
  } catch (error) {
    return {
      status: "fetch_failed",
      url: fetched.url,
      source_url: sourceUrl,
      error: `gist_api_parse_failed:${safeText(error?.message || error, 300)}`,
    };
  }
}

export async function fetchGistExcerpt({ sourceUrl, gist, fetchImpl, lookupFn }) {
  let apiResult;
  try {
    apiResult = await gistApiExcerpt({ id: gist.id, sourceUrl, fetchImpl, lookupFn });
  } catch (error) {
    apiResult = { status: "fetch_failed", source_url: sourceUrl, error: safeText(error?.message || error, 500) };
  }
  if (apiResult.status === "extracted" && apiResult.excerpt) return apiResult;
  const rawUrl = `https://gist.githubusercontent.com/${encodeURIComponent(gist.user)}/${encodeURIComponent(gist.id)}/raw`;
  const fetched = await fetchWithSafeRedirects(rawUrl, { fetchImpl, lookupFn });
  if (fetched.status === "fetched") {
    if (fetched.response.ok) {
      const rawResult = await responseExcerpt({ response: fetched.response, url: fetched.url, sourceUrl });
      return {
        ...rawResult,
        title: rawResult.title || `GitHub Gist ${gist.user}/${gist.id}`,
      };
    }
    return apiResult;
  }
  return apiResult?.status ? apiResult : fetched;
}

export async function fetchUrlExcerpt(url = "", { fetchImpl = fetch, lookupFn = lookup } = {}) {
  const value = safeText(url, 1000);
  if (!value) return null;
  const gist = parseGistUrl(value);
  try {
    if (gist) {
      return await fetchGistExcerpt({ sourceUrl: value, gist, fetchImpl, lookupFn });
    }
    const fetched = await fetchWithSafeRedirects(value, { fetchImpl, lookupFn });
    if (fetched.status !== "fetched") return fetched;
    return responseExcerpt({ response: fetched.response, url: fetched.url });
  } catch (error) {
    return {
      status: "fetch_failed",
      url: value,
      error: safeText(error?.message || error, 500),
    };
  }
}

export async function processedEvidenceFromPayload(payload = {}) {
  const evidence = safeObject(payload.evidence || payload.submission || payload.response);
  const evidenceItems = Array.isArray(payload.evidence_items)
    ? payload.evidence_items
    : Array.isArray(evidence.evidence_items)
      ? evidence.evidence_items
      : [];
  const items = evidenceItems.length > 0 ? evidenceItems : [evidence];
  const artifacts = [];
  for (const item of items.slice(0, 2)) {
    const artifactType = safeText(item?.artifact_type || payload.artifact_type || payload.evidence_type || "text", 80);
    const value = safeText(item?.value || "", 120000);
    artifacts.push({
      artifact_type: artifactType || "text",
      status: item?.file?.processing?.status || "provided",
      source: {
        file_name: item?.file?.name || "",
        mime_type: item?.file?.mime_type || "",
        size: item?.file?.size || null,
        sha256: item?.file?.sha256 || "",
        url: artifactType === "url" ? value : "",
      },
      excerpt: safeText(item?.file?.description || item?.file?.text || value || item?.notes || payload.response_text, 6000),
      processing: safeObject(item?.file?.processing),
    });
    if (artifactType === "url") {
      const fetched = await fetchUrlExcerpt(value);
      if (fetched) artifacts.push({ artifact_type: "url", ...fetched });
    }
  }
  return {
    schema: "tasknode.processed_evidence.v1",
    artifacts,
  };
}

export function artifactUrl(artifact = {}) {
  return safeText(artifact.url || artifact.source_url || safeObject(artifact.source).url || "", 1000);
}

export function artifactLabel(artifact = {}, fallback = "Evidence artifact") {
  const source = safeObject(artifact.source);
  const url = artifactUrl(artifact);
  if (artifact.title) return safeText(artifact.title, 240);
  if (source.file_name) return safeText(source.file_name, 240);
  if (url) {
    try {
      const parsed = new URL(url);
      return safeText(parsed.hostname, 240);
    } catch {
      return safeText(url, 240);
    }
  }
  return fallback;
}

export function classifyProcessedEvidenceArtifact(artifact = {}, {
  phase = "",
  fetchedUrls = new Set(),
} = {}) {
  const type = safeText(artifact.artifact_type || artifact.artifactType || "text", 80) || "text";
  const status = safeText(artifact.status, 80);
  const url = artifactUrl(artifact);
  const digestInput = url || artifact.excerpt || artifactLabel(artifact);
  if (url && fetchedUrls.has(url) && status === "provided") return null;
  if (url) {
    const verified = status === "extracted" || artifact.ok === true;
    const failed = ["blocked", "fetch_failed", "http_error", "too_many_redirects", "redirect_not_followed"].includes(status) || artifact.ok === false;
    return {
      phase,
      artifact_type: type,
      resolver: type === "github_commit" ? "github_commit" : "safe_url",
      status: verified ? "verified" : failed ? "unverified" : "self_attested",
      label: artifactLabel(artifact, "URL evidence"),
      url,
      value_digest: digestInput ? `sha256:${sha256(digestInput)}` : "",
      reason: verified
        ? "Public URL content was fetched through the SSRF-safe evidence resolver."
        : failed
          ? safeText(artifact.error || `URL evidence could not be independently fetched (${status || "unknown"}).`, 300)
          : "URL was submitted but no resolver result was available in processed evidence.",
    };
  }
  return {
    phase,
    artifact_type: type,
    resolver: "text_or_file_claim",
    status: "self_attested",
    label: artifactLabel(artifact, type === "file" ? "File evidence" : "Text evidence"),
    value_digest: digestInput ? `sha256:${sha256(digestInput)}` : "",
    reason: "Evidence was submitted as text/file material without an independently resolvable public artifact.",
  };
}

export function buildRewardEvidenceEvaluationContext({ initial = {}, verification = {} } = {}) {
  const groups = [
    ["initial_submission", initial],
    ["verification_response", verification],
  ];
  const artifactVerdicts = [];
  for (const [phase, packet] of groups) {
    const artifacts = safeArray(safeObject(packet).artifacts).slice(0, 12);
    const fetchedUrls = new Set(
      artifacts
        .filter((artifact) => artifactUrl(artifact) && artifact.status && artifact.status !== "provided")
        .map(artifactUrl)
    );
    for (const artifact of artifacts) {
      const verdict = classifyProcessedEvidenceArtifact(artifact, { phase, fetchedUrls });
      if (verdict) artifactVerdicts.push(verdict);
    }
  }
  const counts = artifactVerdicts.reduce(
    (acc, verdict) => {
      if (verdict.status === "verified") acc.verified += 1;
      else if (verdict.status === "unverified") acc.unverified += 1;
      else acc.self_attested += 1;
      return acc;
    },
    { verified: 0, self_attested: 0, unverified: 0 }
  );
  const summary = `${counts.verified} verified public artifact(s), ${counts.self_attested} self-attested claim(s), ${counts.unverified} unverified artifact(s).`;
  return {
    schema: "tasknode.reward_evidence_evaluation_context.v1",
    lifecycle_boundary: "advisory_context_only_no_reward_rule_change",
    summary,
    counts,
    artifact_verdicts: artifactVerdicts.slice(0, 24),
    scoring_guidance: [
      "Verified public artifacts can support completion when they match the task contract.",
      "Self-attested claims are useful context but should not be treated as independently proven.",
      "Unverified external-action claims should lower evidence confidence unless other evidence corroborates them.",
    ],
  };
}

export function collectEvidenceText(value, {
  maxChars = 30000,
  maxDepth = 6,
} = {}) {
  const parts = [];
  let used = 0;
  const visit = (node, depth = 0) => {
    if (used >= maxChars || depth > maxDepth || node === null || node === undefined) return;
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      const text = safeText(node, Math.max(0, maxChars - used));
      if (text) {
        parts.push(text);
        used += text.length + 1;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 50)) visit(item, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const [key, item] of Object.entries(node).slice(0, 80)) {
        if (used >= maxChars) break;
        const keyText = safeText(key, 120);
        if (keyText) {
          parts.push(keyText);
          used += keyText.length + 1;
        }
        visit(item, depth + 1);
      }
    }
  };
  visit(value, 0);
  return safeText(parts.join("\n"), maxChars);
}

export function evidencePayloadHasScreenshot(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.slice(0, 50).some((item) => evidencePayloadHasScreenshot(item, depth + 1));
  if (typeof value !== "object") return false;
  const object = safeObject(value);
  const typeText = [
    object.artifact_type,
    object.artifactType,
    object.evidence_type,
    object.evidenceType,
    object.verification_type,
    object.verificationType,
    object.type,
  ]
    .map((item) => safeText(item, 120).toLowerCase())
    .filter(Boolean)
    .join(" ");
  if (/\b(screenshot|screen\s*shot|image|photo)\b/.test(typeText)) return true;
  const source = safeObject(object.source);
  const file = safeObject(object.file);
  const mime = safeText(object.mime_type || object.mimeType || source.mime_type || source.mimeType || file.mime_type || file.mimeType, 160).toLowerCase();
  if (mime.startsWith("image/")) return true;
  const fileName = safeText(object.file_name || object.fileName || object.filename || object.name || source.file_name || file.name, 500).toLowerCase();
  if (/\.(png|jpe?g|webp|gif|heic)$/i.test(fileName)) return true;
  return Object.values(object).slice(0, 80).some((item) => evidencePayloadHasScreenshot(item, depth + 1));
}

export function normalizeBooleanFlag(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  const text = safeText(value, 80).toLowerCase();
  return ["true", "1", "yes", "required", "require", "on"].includes(text);
}

export function splitConfigList(value = "") {
  return safeText(value, 4000)
    .split(/[,\s]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseDiscordMessageLink(value = "") {
  const match = safeText(value, 1000).match(
    /https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(\d{15,25})\/(\d{15,25})\/(\d{15,25})/i
  );
  if (!match) return null;
  return {
    guildId: match[1],
    channelId: match[2],
    messageId: match[3],
    url: safeText(match[0], 500),
  };
}

export function discordEvidencePolicy(env = process.env) {
  return {
    allowedGuildIds: splitConfigList(env.TASKNODE_DISCORD_ALLOWED_GUILD_IDS || env.TASKNODE_DISCORD_ANNOUNCEMENT_GUILD_IDS),
    allowedChannelIds: splitConfigList(env.TASKNODE_DISCORD_ALLOWED_CHANNEL_IDS || env.TASKNODE_DISCORD_ANNOUNCEMENT_CHANNEL_IDS),
    botToken: safeText(env.TASKNODE_DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN, 4000),
    requireResolvableMessage: normalizeBooleanFlag(env.TASKNODE_DISCORD_REQUIRE_RESOLVABLE_MESSAGE),
  };
}

export function discordAnnouncementEvidenceStatus({
  initialSubmission = {},
  verificationResponse = {},
  processedInitial = {},
  processedVerification = {},
} = {}) {
  const packets = [verificationResponse, initialSubmission, processedVerification, processedInitial];
  const text = collectEvidenceText(packets);
  const discordMessage = parseDiscordMessageLink(text);
  if (discordMessage) {
    return {
      ok: true,
      evidence_type: "discord_message_link",
      evidence_ref: discordMessage.url,
      discord_message: discordMessage,
      reason: "Discord message link evidence was provided.",
    };
  }
  const messageId =
    text.match(/\bdiscord\b[\s\S]{0,80}\b(?:message|msg)?\s*(?:id|link)?\s*[:#-]?\s*(\d{15,25})\b/i) ||
    text.match(/\b(?:message|msg)\s*id\s*[:#-]?\s*(\d{15,25})\b[\s\S]{0,80}\bdiscord\b/i);
  if (messageId?.[1]) {
    return {
      ok: true,
      evidence_type: "discord_message_id",
      evidence_ref: safeText(messageId[1], 80),
      discord_message: {
        guildId: "",
        channelId: "",
        messageId: safeText(messageId[1], 80),
        url: "",
      },
      reason: "Discord message id evidence was provided.",
    };
  }
  const hasScreenshot = packets.some((packet) => evidencePayloadHasScreenshot(packet));
  if (hasScreenshot && /\bdiscord\b/i.test(text)) {
    return {
      ok: true,
      evidence_type: "discord_announcement_screenshot",
      evidence_ref: "screenshot_or_image_artifact",
      discord_message: null,
      reason: "Screenshot or image evidence was provided with Discord announcement context.",
    };
  }
  return {
    ok: false,
    evidence_type: "",
    evidence_ref: "",
    reason: hasScreenshot
      ? "Screenshot or image evidence was present, but it was not tied to a Discord announcement."
      : "Missing Discord message link, Discord message id, or Discord-labeled announcement screenshot evidence.",
  };
}

export async function resolveDiscordAnnouncementEvidenceStatus(input = {}, {
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const status = discordAnnouncementEvidenceStatus(input);
  if (!status.ok) return status;
  const policy = discordEvidencePolicy(env);
  const message = safeObject(status.discord_message);
  const channelId = safeText(message.channelId, 80);
  const guildId = safeText(message.guildId, 80);
  const messageId = safeText(message.messageId, 80);

  if (channelId && policy.allowedChannelIds.length && !policy.allowedChannelIds.includes(channelId)) {
    return {
      ...status,
      ok: false,
      discord_validation: {
        status: "rejected",
        reason: "channel_not_allowed",
        channelId,
      },
      reason: "Discord message link points to a channel that is not in the approved announcement channel allowlist.",
    };
  }
  if (guildId && policy.allowedGuildIds.length && !policy.allowedGuildIds.includes(guildId)) {
    return {
      ...status,
      ok: false,
      discord_validation: {
        status: "rejected",
        reason: "guild_not_allowed",
        guildId,
      },
      reason: "Discord message link points to a guild that is not in the approved announcement guild allowlist.",
    };
  }

  if (policy.requireResolvableMessage && (!channelId || !messageId)) {
    return {
      ...status,
      ok: false,
      discord_validation: {
        status: "unresolved",
        reason: "message_link_required_for_resolution",
      },
      reason: "Discord evidence must include a message link with channel id so the bot can resolve it.",
    };
  }

  if (policy.botToken && channelId && messageId) {
    try {
      const response = await fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`, {
        headers: {
          authorization: `Bot ${policy.botToken}`,
          "user-agent": TASK_REVIEW_USER_AGENT,
        },
      });
      if (!response.ok) {
        return {
          ...status,
          ok: false,
          discord_validation: {
            status: "unverified",
            reason: `discord_api_http_${response.status}`,
            channelId,
            messageId,
          },
          reason: `Discord bot could not verify the announcement message (HTTP ${response.status}).`,
        };
      }
      return {
        ...status,
        discord_validation: {
          status: "verified",
          reason: "discord_api_message_exists",
          channelId,
          messageId,
        },
        reason: "Discord announcement message link was verified by the configured Discord bot.",
      };
    } catch (error) {
      return {
        ...status,
        ok: false,
        discord_validation: {
          status: "unverified",
          reason: "discord_api_fetch_failed",
          channelId,
          messageId,
          error: safeText(error?.message || error, 300),
        },
        reason: "Discord bot could not verify the announcement message.",
      };
    }
  }

  return {
    ...status,
    discord_validation: {
      status: channelId && messageId ? "syntactic" : "self_attested",
      reason: channelId && messageId
        ? "message_link_shape_valid_without_bot_resolution"
        : "no_resolvable_message_link_available",
    },
  };
}
