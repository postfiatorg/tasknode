import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign as cryptoSign, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = path.join(ROOT, "schemas", "finance-hub");

const loadSchema = (name) => JSON.parse(readFileSync(path.join(SCHEMA_DIR, name), "utf8"));
const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
const computeLeaderboardScore = ({ networkTasks = 0, personalTasks = 0, rewards = 0, alignment = 0 } = {}) =>
  Number((networkTasks * 3 + personalTasks * 1 + rewards / 25000 + alignment * 1).toFixed(6));

const compareUtf8Bytes = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

// canonical-json-v1 as defined in docs/specs/finance-hub-contracts-v1.md, "Canonical Signing Input".
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort(compareUtf8Bytes)
      .map((k) => `${canonicalJson(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  if (typeof value === "string" && value.isWellFormed()) return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "boolean" || value === null) return String(value);
  throw new TypeError("canonical-json-v1 cannot encode this value");
}

function resolveRef(rootSchema, ref) {
  assert.ok(ref.startsWith("#/"), `Only local JSON Pointer $ref supported, got ${ref}`);
  return ref.slice(2).split("/").reduce((node, part) => {
    assert.ok(node && Object.hasOwn(node, part), `Unresolved $ref ${ref}`);
    return node[part];
  }, rootSchema);
}

function jsonTypeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function validateSchema(value, schema, rootSchema = schema, pointer = "$") {
  const errors = [];
  if (schema.$ref) return validateSchema(value, resolveRef(rootSchema, schema.$ref), rootSchema, pointer);

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = jsonTypeOf(value);
    if (!allowed.includes(actual) && !(actual === "integer" && allowed.includes("number"))) {
      return [`${pointer}: expected type ${allowed.join("|")}, got ${actual}`];
    }
  }
  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(value, schema.const)) {
    errors.push(`${pointer}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => isDeepStrictEqual(value, entry))) {
    errors.push(`${pointer}: value ${JSON.stringify(value)} not in enum`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${pointer}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${pointer}: too long`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${pointer}: pattern mismatch`);
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(value))) errors.push(`${pointer}: invalid date-time`);
    if (schema.format === "date" && !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) errors.push(`${pointer}: invalid date`);
    if (schema.format === "uri") {
      try { new URL(value); } catch { errors.push(`${pointer}: invalid uri`); }
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${pointer}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${pointer}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${pointer}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${pointer}: too many items`);
    if (schema.uniqueItems && value.some((item, i) => value.findIndex((other) => isDeepStrictEqual(other, item)) !== i)) {
      errors.push(`${pointer}: duplicate item`);
    }
    if (schema.items) value.forEach((item, i) => errors.push(...validateSchema(item, schema.items, rootSchema, `${pointer}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const props = schema.properties || {};
    for (const reqKey of schema.required || []) {
      if (!Object.hasOwn(value, reqKey)) errors.push(`${pointer}: missing ${reqKey}`);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) errors.push(...validateSchema(entry, props[key], rootSchema, `${pointer}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${pointer}: unexpected property ${key}`);
    }
  }
  for (const sub of schema.allOf || []) errors.push(...validateSchema(value, sub, rootSchema, pointer));
  if (schema.if) {
    const condOk = validateSchema(value, schema.if, rootSchema, pointer).length === 0;
    if (condOk && schema.then) errors.push(...validateSchema(value, schema.then, rootSchema, pointer));
    else if (!condOk && schema.else) errors.push(...validateSchema(value, schema.else, rootSchema, pointer));
  }
  return errors;
}

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "price_target", "target_price", "upside", "upside_pct", "downside_pct", "fair_value", "dcf_value",
  "model_estimate", "model_estimate_before", "market_consensus_before", "eps_estimate", "revenue_estimate",
  "bull_case_target", "bear_case_target", "base_case_target", "member_questions", "open_model_questions",
  "pooled_claims", "contributor_claims", "content_key", "api_key", "secret", "private_key", "mnemonic",
  "deep_memory", "agent_brief_members",
]);

const FORBIDDEN_PUBLIC_PATTERNS = [
  { name: "price_target_phrase", re: /\b(?:price\s+target|target\s+price)\b/i },
  { name: "pt_dollar_shorthand", re: /\bPT\s*(?:of|:|=)?\s*\$\s*\d/i },
  { name: "upside_downside_pct", re: /\b(?:upside|downside)\s+(?:of\s+)?[+-]?\d+(?:\.\d+)?%/i },
  { name: "proprietary_model_projection", re: /\bour\s+model\s+(?:projects|estimates|forecasts|targets)\b/i },
  { name: "gated_index_reference", re: /\b(?:ga-models|agent_brief_members)\b/i },
  { name: "private_key_pem", re: /BEGIN\s+[A-Z ]*PRIVATE KEY/ },
  { name: "openai_or_stripe_key", re: /\bsk-(?:live|test|proj)?-?[A-Za-z0-9]{16,}\b/ },
  { name: "github_pat", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "raw_html_or_js_uri", re: /<(?:script|iframe|img|svg|object)\b|onerror\s*=|javascript:/i },
];

function scanForPublicLeaks(value, pointer = "$") {
  const leaks = [];
  if (typeof value === "string") {
    for (const rule of FORBIDDEN_PUBLIC_PATTERNS) {
      if (rule.re.test(value)) leaks.push(`${pointer}: matched ${rule.name}`);
    }
    return leaks;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => leaks.push(...scanForPublicLeaks(item, `${pointer}[${i}]`)));
    return leaks;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key.toLowerCase())) leaks.push(`${pointer}.${key}: forbidden key`);
      leaks.push(...scanForPublicLeaks(entry, `${pointer}.${key}`));
    }
  }
  return leaks;
}

function buildPublishSigningMessage(payload) {
  const normalizedFiles = [...payload.files]
    .map(({ content_base64: _ignored, ...rest }) => rest)
    .sort((a, b) => compareUtf8Bytes(a.path, b.path));
  const canonicalFiles = canonicalJson(normalizedFiles);
  const manifestSha256 = sha256Hex(canonicalFiles);
  const envelopeWithoutSig = { ...payload, manifest_sha256: manifestSha256, files: normalizedFiles };
  delete envelopeWithoutSig.signature;
  const canonicalEnvelope = canonicalJson(envelopeWithoutSig);
  const payloadSha256 = sha256Hex(canonicalEnvelope);
  const message = ["postfiat.finance-hub.publish.v1", payload.index_id, String(payload.version), payload.nonce, payloadSha256].join("\n");
  return { canonicalFiles, canonicalEnvelope, manifestSha256, payloadSha256, message };
}

function signPublishPayload(unsignedPayload, { algorithm, keyId, privateKey, hmacSecret }) {
  const { manifestSha256, payloadSha256, message } = buildPublishSigningMessage(unsignedPayload);
  const value = algorithm === "ed25519"
    ? cryptoSign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url")
    : createHmac("sha256", hmacSecret).update(message, "utf8").digest("hex");
  return {
    ...unsignedPayload,
    manifest_sha256: manifestSha256,
    signature: { algorithm, key_id: keyId, signing_input_version: "canonical-json-v1", payload_sha256: payloadSha256, value },
  };
}

function verifyPublishPayload(payload, { keyRing, currentVersion, seenNonces, nowMs }) {
  const schemaErrors = validateSchema(payload, loadSchema("publish_payload.v1.schema.json"));
  if (schemaErrors.length) return { ok: false, error: "schema_invalid", details: schemaErrors };
  if (payload.version <= currentVersion) return { ok: false, error: "version_not_monotonic" };
  if (payload.operation === "rollback" && payload.rollback_target_version >= payload.version) return { ok: false, error: "rollback_target_not_older" };
  if (payload.render_gate.file_count !== payload.files.length) return { ok: false, error: "file_count_mismatch" };

  const issuedMs = Date.parse(payload.issued_at);
  const expiresMs = Date.parse(payload.expires_at);
  if (Math.abs(nowMs - issuedMs) > 300_000) return { ok: false, error: "issued_at_out_of_window" };
  if (expiresMs <= issuedMs || expiresMs - issuedMs > 600_000 || nowMs > expiresMs) return { ok: false, error: "envelope_expired_or_invalid_ttl" };

  const nonceKey = `${payload.index_id}:${payload.nonce}`;
  if (seenNonces.has(nonceKey)) return { ok: false, error: "nonce_replayed" };

  const keyEntry = keyRing.get(`${payload.index_id}:${payload.signature.key_id}`);
  if (!keyEntry || keyEntry.algorithm !== payload.signature.algorithm) return { ok: false, error: "unknown_or_mismatched_key" };

  const { manifestSha256, payloadSha256, message } = buildPublishSigningMessage(payload);
  if (payload.manifest_sha256 !== manifestSha256 || payload.signature.payload_sha256 !== payloadSha256) return { ok: false, error: "digest_mismatch" };

  if (keyEntry.algorithm === "ed25519") {
    if (!cryptoVerify(null, Buffer.from(message, "utf8"), keyEntry.publicKey, Buffer.from(payload.signature.value, "base64url"))) {
      return { ok: false, error: "signature_invalid" };
    }
  } else {
    const expected = Buffer.from(createHmac("sha256", keyEntry.hmacSecret).update(message, "utf8").digest("hex"), "utf8");
    const actual = Buffer.from(payload.signature.value, "utf8");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, error: "signature_invalid" };
  }

  if (new Set(payload.files.map((file) => file.path)).size !== payload.files.length) return { ok: false, error: "duplicate_file_path" };
  if (payload.files.reduce((sum, file) => sum + file.size_bytes, 0) !== payload.total_bytes) return { ok: false, error: "total_bytes_mismatch" };
  for (const file of payload.files) {
    if (file.content_base64 === undefined) continue;
    const content = Buffer.from(file.content_base64, "base64");
    if (content.length !== file.size_bytes) return { ok: false, error: "file_size_mismatch" };
    if (sha256Hex(content) !== file.sha256) return { ok: false, error: "file_hash_mismatch" };
  }

  seenNonces.add(nonceKey);
  return { ok: true };
}

// Every purpose the server puts in a "Post Fiat Task Node wallet proof" challenge.
function serverWalletProofPurposes() {
  const serverDir = path.join(ROOT, "server");
  const purposes = new Set();
  for (const name of readdirSync(serverDir, { recursive: true })) {
    if (!name.endsWith(".js")) continue;
    const source = readFileSync(path.join(serverDir, name), "utf8");
    const calls = source.match(/(?<!function )\bcreateWalletChallenge\(/g) || [];
    const named = [...source.matchAll(/(?<!function )\bcreateWalletChallenge\(\{[^}]*?\bpurpose: "([a-z_]+)"/g)];
    assert.equal(named.length, calls.length, `${name}: every createWalletChallenge call must name its purpose as a string literal`);
    for (const [, purpose] of named) purposes.add(purpose);
  }
  return [...purposes].sort();
}

function goldenCoverageManifest() {
  return {
    schema_version: "finance-hub.coverage-manifest.v1",
    generated_at: "2026-11-27T01:00:00Z",
    publication_version: 42,
    universe_policy: {
      allowed_asset_classes: ["crypto_protocol", "perp_megacap_equity"],
      exclude_non_perp_equities: true,
      public_safe_only: true,
    },
    assets: [
      {
        model_id: "SOL", ticker: "SOL", name: "Solana", asset_class: "crypto_protocol",
        perp_venues: ["hyperliquid", "binance", "bybit"], perp_liquidity_verified: true,
        area_tags: ["layer1", "validator-economics", "defi-throughput", "mev"],
        eligible_info_types: ["operator", "builder", "trader", "public_data_analyst"],
        interview_mode: "member_and_public", paid_interviews_enabled: true, equity_counsel_approved: false,
        public_brief_path: "public/briefs/SOL.json", status: "active", updated_at: "2026-11-27T01:00:00Z",
      },
      {
        model_id: "NVDA", ticker: "NVDA", name: "NVIDIA Corporation", asset_class: "perp_megacap_equity",
        perp_venues: ["hyperliquid"], perp_liquidity_verified: true,
        area_tags: ["ai-accelerators", "datacenter-capex", "cuda-ecosystem"],
        eligible_info_types: ["operator", "customer", "trader", "public_data_analyst"],
        interview_mode: "counsel_pending", paid_interviews_enabled: false, equity_counsel_approved: false,
        public_brief_path: "public/briefs/NVDA.json", status: "active", updated_at: "2026-11-27T01:00:00Z",
      },
    ],
  };
}

function goldenAgentBriefPublic() {
  return {
    schema_version: "finance-hub.agent-brief-public.v1",
    index_scope: "public_safe",
    model_id: "NVDA", ticker: "NVDA", name: "NVIDIA Corporation", asset_class: "perp_megacap_equity",
    generated_at: "2026-11-27T01:00:00Z", publication_version: 42,
    public_summary: "NVIDIA designs GPU compute platforms, networking interconnects, and CUDA software stacks deployed across public cloud hyperscalers and enterprise AI clusters.",
    area_tags: ["ai-accelerators", "datacenter-capex", "cuda-ecosystem"],
    public_topics: [
      {
        topic_id: "cloud-inference-utilization",
        title: "Public cloud GPU instance availability and queue behavior",
        description: "Observable cloud instance pricing, waitlist behavior, and deployment lead times reported by infrastructure buyers in public markets.",
        observable_by: ["operator", "customer", "public_data_analyst"],
      },
      {
        topic_id: "software-migration-friction",
        title: "Inference framework portability across accelerators",
        description: "Developer experience porting open-weight inference workloads across CUDA and competing compiler stacks using publicly available benchmarks.",
        observable_by: ["builder", "operator"],
      },
    ],
    public_questions: [
      {
        question_id: "q-triangulate-role",
        prompt: "Which public cloud or open-benchmark GPU workloads do you directly observe in your day-to-day technical work?",
        phase: "triangulation", mnpi_safe_verified: true,
      },
      {
        question_id: "q-public-availability",
        prompt: "Based strictly on public cloud spot/on-demand listings and open documentation, how has high-memory GPU capacity availability shifted over the past quarter?",
        phase: "public_probe", mnpi_safe_verified: true,
      },
    ],
    public_context_links: [{ title: "NVIDIA Investor Relations Public Filings", url: "https://investor.nvidia.com/financial-info/sec-filings/default.aspx" }],
    redaction_attestation: {
      contains_price_targets: false, contains_internal_estimates: false, contains_member_claims: false,
      contains_private_memory: false, leak_scan_passed: true, scanner_version: "public-brief-guard-v1",
    },
  };
}

function goldenTop30Snapshot() {
  const rows = [
    {
      account_id: "acct_alpha_public", network_tasks: 20, personal_tasks: 40, rewards_pft: 250000, alignment_score: 92,
      is_public_profile: true, rank: 1, access_basis: "top30", entitlement_state: "seated_top30", previous_rank: 1,
      grace_started_at: null, grace_ends_at: null, grace_cooldown_until: null,
    },
    {
      account_id: "acct_beta_private", network_tasks: 12, personal_tasks: 25, rewards_pft: 100000, alignment_score: 85,
      is_public_profile: false, rank: 2, access_basis: "top30", entitlement_state: "seated_top30", previous_rank: 3,
      grace_started_at: null, grace_ends_at: null, grace_cooldown_until: null,
    },
    {
      account_id: "acct_gamma_tie", network_tasks: 12, personal_tasks: 25, rewards_pft: 100000, alignment_score: 85,
      is_public_profile: true, rank: 3, access_basis: "top30", entitlement_state: "seated_top30", previous_rank: 2,
      grace_started_at: null, grace_ends_at: null, grace_cooldown_until: null,
    },
    {
      account_id: "acct_hysteresis_33", network_tasks: 4, personal_tasks: 12, rewards_pft: 25000, alignment_score: 70,
      is_public_profile: true, rank: 33, access_basis: "top30", entitlement_state: "retained_hysteresis_31_35", previous_rank: 29,
      grace_started_at: null, grace_ends_at: null, grace_cooldown_until: null,
    },
    {
      account_id: "acct_grace_37", network_tasks: 3, personal_tasks: 10, rewards_pft: 12500, alignment_score: 64,
      is_public_profile: false, rank: 37, access_basis: "grace", entitlement_state: "grace_7d", previous_rank: 34,
      grace_started_at: "2026-11-27T00:00:00Z", grace_ends_at: "2026-12-04T00:00:00Z", grace_cooldown_until: "2026-12-27T00:00:00Z",
    },
  ].map((entry) => ({
    ...entry,
    is_active_validator: false,
    score: computeLeaderboardScore({
      networkTasks: entry.network_tasks, personalTasks: entry.personal_tasks,
      rewards: entry.rewards_pft, alignment: entry.alignment_score,
    }),
  }));

  return {
    schema_version: "finance-hub.top30-snapshot.v1",
    snapshot_id: "top30-2026-11-27T00-00-00Z",
    snapshot_date_utc: "2026-11-27",
    snapshot_at: "2026-11-27T00:00:00Z",
    status: "active",
    formula: {
      label: "3x network tasks + personal tasks + rewards/25000 + alignment",
      network_task_weight: 3, personal_task_weight: 1, reward_divisor: 25000, alignment_weight: 1,
      tie_break_order: ["score_desc", "network_tasks_desc", "rewards_desc", "account_id_asc"],
    },
    policy: {
      seat_count: 30, keep_until_rank: 35, grace_days: 7, grace_cooldown_days: 30,
      exclude_active_validators: true, include_private_accounts: true, exclude_blacklisted: true, exclude_suspended: true,
    },
    summary: {
      eligible_non_validator_accounts: 148, excluded_active_validators: 24,
      excluded_blacklisted_or_suspended: 6, seated_count: 3, hysteresis_retained_count: 1, grace_count: 1,
    },
    entries: rows,
  };
}

test("all four Finance Hub schemas use Draft 2020-12 and closed objects", () => {
  for (const name of [
    "coverage_manifest.v1.schema.json", "agent_brief_public.v1.schema.json",
    "publish_payload.v1.schema.json", "top30_snapshot.v1.schema.json",
  ]) {
    const schema = loadSchema(name);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.additionalProperties, false);
    for (const def of Object.values(schema.$defs || {})) {
      if (def.type === "object") assert.equal(def.additionalProperties, false);
    }
  }
});

test("coverage_manifest.v1 validates crypto + perp-backed megacap equities and rejects random equities", () => {
  const schema = loadSchema("coverage_manifest.v1.schema.json");
  const valid = goldenCoverageManifest();
  assert.deepEqual(validateSchema(valid, schema), []);
  assert.deepEqual(scanForPublicLeaks(valid), []);

  const randomEquity = structuredClone(valid);
  randomEquity.assets[1].asset_class = "smallcap_equity";
  assert.ok(validateSchema(randomEquity, schema).length > 0);

  const nonPerpEquity = structuredClone(valid);
  nonPerpEquity.assets[1].perp_venues = [];
  assert.ok(validateSchema(nonPerpEquity, schema).length > 0);

  const unverifiedLiquidity = structuredClone(valid);
  unverifiedLiquidity.assets[1].perp_liquidity_verified = false;
  assert.ok(validateSchema(unverifiedLiquidity, schema).length > 0);

  const unapprovedPaidEquity = structuredClone(valid);
  unapprovedPaidEquity.assets[1].paid_interviews_enabled = true;
  unapprovedPaidEquity.assets[1].equity_counsel_approved = false;
  assert.ok(validateSchema(unapprovedPaidEquity, schema).length > 0);

  const approvedPaidEquity = structuredClone(valid);
  approvedPaidEquity.assets[1].paid_interviews_enabled = true;
  approvedPaidEquity.assets[1].equity_counsel_approved = true;
  approvedPaidEquity.assets[1].interview_mode = "member_and_public";
  assert.deepEqual(validateSchema(approvedPaidEquity, schema), []);

  const leakedTarget = structuredClone(valid);
  leakedTarget.assets[0].price_target = 450;
  assert.ok(validateSchema(leakedTarget, schema).length > 0);
});

test("agent_brief_public.v1 validates leak-safe briefs and blocks internal targets, member claims, and secrets", () => {
  const schema = loadSchema("agent_brief_public.v1.schema.json");
  const valid = goldenAgentBriefPublic();
  assert.deepEqual(validateSchema(valid, schema), []);
  assert.deepEqual(scanForPublicLeaks(valid), []);

  const wrongScope = structuredClone(valid);
  wrongScope.index_scope = "ga-models";
  assert.ok(validateSchema(wrongScope, schema).length > 0);

  for (const field of ["price_target", "upside_pct", "model_estimate", "open_model_questions", "pooled_claims", "content_key", "deep_memory"]) {
    const mutated = structuredClone(valid);
    mutated[field] = "redacted-test";
    assert.ok(validateSchema(mutated, schema).length > 0, `schema must reject ${field}`);
    assert.ok(scanForPublicLeaks(mutated).length > 0, `leak scanner must reject ${field}`);
  }

  const badAttestation = structuredClone(valid);
  badAttestation.redaction_attestation.contains_price_targets = true;
  assert.ok(validateSchema(badAttestation, schema).length > 0);

  const syntheticApiKey = ["sk", "live", "9876543210abcdef123456"].join("-");
  const syntheticPemHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  for (const snippet of [
    "Consensus sits below our price target of $240 per share.",
    "Implied PT: $185 based on FY27 multiple.",
    "We see upside of +42.5% over the next twelve months.",
    "Our model estimates $14.20 in non-GAAP EPS.",
    "Refer to ga-models/models/NVDA/outputs.json for full tabs.",
    `Leaked bearer ${syntheticApiKey}`,
    syntheticPemHeader,
    "<script>fetch('https://evil.example')</script>",
  ]) {
    const leaked = structuredClone(valid);
    leaked.public_summary = `${valid.public_summary} ${snippet}`;
    assert.ok(scanForPublicLeaks(leaked).length > 0, `leak scanner must catch: ${snippet}`);
  }
});

test("publish_payload.v1 verifies Ed25519 & HMAC signatures, replay protection, index isolation, and monotonic rollbacks", () => {
  const nowIso = "2026-11-27T01:30:00Z";
  const nowMs = Date.parse(nowIso);
  const expiresIso = "2026-11-27T01:35:00Z";
  const edKeys = generateKeyPairSync("ed25519");
  const hmacSecret = randomBytes(32);
  const keyRing = new Map([
    ["ga-models:ga-models-ed25519-k1", { algorithm: "ed25519", publicKey: edKeys.publicKey }],
    ["finance-hub-public:public-ed25519-k1", { algorithm: "ed25519", publicKey: edKeys.publicKey }],
    ["goodbrief:goodbrief-hmac-k1", { algorithm: "hmac-sha256", hmacSecret }],
  ]);
  const seenNonces = new Set();

  const indexHtml = Buffer.from("<!doctype html><h1>Finance Hub</h1>\n", "utf8");
  const baseUnsigned = {
    schema_version: "finance-hub.publish-payload.v1",
    index_id: "ga-models", tier: "finance_hub", allowed_bases: ["validator", "top30", "grace"],
    version: 42, operation: "publish", issued_at: nowIso, expires_at: expiresIso,
    nonce: "nonce_ga_models_v42_9f8a7b6c5d4e", title: "Finance Hub Models", summary: "Scheduled refresh",
    manifest_sha256: "0".repeat(64), total_bytes: indexHtml.length,
    files: [{ path: "index.html", sha256: sha256Hex(indexHtml), size_bytes: indexHtml.length, content_type: "text/html; charset=utf-8", encoding: "identity", content_base64: indexHtml.toString("base64") }],
    render_gate: { passed: true, shrink_guard_passed: true, public_leak_scan_passed: false, file_count: 1 },
  };

  const gaSigned = signPublishPayload(baseUnsigned, { algorithm: "ed25519", keyId: "ga-models-ed25519-k1", privateKey: edKeys.privateKey });
  assert.deepEqual(verifyPublishPayload(gaSigned, { keyRing, currentVersion: 41, seenNonces, nowMs }), { ok: true });
  assert.equal(verifyPublishPayload(gaSigned, { keyRing, currentVersion: 42, seenNonces, nowMs }).error, "version_not_monotonic");
  assert.equal(verifyPublishPayload(gaSigned, { keyRing, currentVersion: 41, seenNonces, nowMs }).error, "nonce_replayed");

  const tampered = { ...structuredClone(gaSigned), version: 43, nonce: "nonce_ga_models_tampered_1234567890" };
  assert.equal(verifyPublishPayload(tampered, { keyRing, currentVersion: 42, seenNonces, nowMs }).error, "digest_mismatch");

  const goodbriefHtml = Buffer.from("<article>Goodbrief Morning Roundup</article>\n", "utf8");
  const goodbriefSigned = signPublishPayload({
    ...baseUnsigned, index_id: "goodbrief", version: 105, nonce: "nonce_goodbrief_v105_abcdef123456",
    title: "Goodbrief Daily Macro Roundup", total_bytes: goodbriefHtml.length,
    files: [{ path: "index.html", sha256: sha256Hex(goodbriefHtml), size_bytes: goodbriefHtml.length, content_type: "text/html; charset=utf-8", encoding: "identity", content_base64: goodbriefHtml.toString("base64") }],
  }, { algorithm: "hmac-sha256", keyId: "goodbrief-hmac-k1", hmacSecret });
  assert.deepEqual(verifyPublishPayload(goodbriefSigned, { keyRing, currentVersion: 104, seenNonces, nowMs }), { ok: true });

  const manifestBytes = Buffer.from(canonicalJson(goldenCoverageManifest()), "utf8");
  const publicSigned = signPublishPayload({
    ...baseUnsigned, index_id: "finance-hub-public", tier: "public_safe", allowed_bases: ["public"],
    version: 7, nonce: "nonce_public_v7_abcdef1234567890", title: "Finance Hub Public Manifest", total_bytes: manifestBytes.length,
    files: [{ path: "hub/coverage_manifest.json", sha256: sha256Hex(manifestBytes), size_bytes: manifestBytes.length, content_type: "application/json", encoding: "identity", content_base64: manifestBytes.toString("base64") }],
    render_gate: { passed: true, shrink_guard_passed: true, public_leak_scan_passed: true, file_count: 1 },
  }, { algorithm: "ed25519", keyId: "public-ed25519-k1", privateKey: edKeys.privateKey });
  assert.deepEqual(verifyPublishPayload(publicSigned, { keyRing, currentVersion: 6, seenNonces, nowMs }), { ok: true });

  const rollbackSigned = signPublishPayload({
    ...baseUnsigned, version: 43, operation: "rollback", rollback_target_version: 41,
    rollback_of_manifest_sha256: gaSigned.manifest_sha256, nonce: "nonce_ga_models_rollback_v43_123456",
    files: baseUnsigned.files.map(({ content_base64: _b64, ...rest }) => rest),
  }, { algorithm: "ed25519", keyId: "ga-models-ed25519-k1", privateKey: edKeys.privateKey });
  assert.deepEqual(verifyPublishPayload(rollbackSigned, { keyRing, currentVersion: 42, seenNonces, nowMs }), { ok: true });

  const schema = loadSchema("publish_payload.v1.schema.json");
  const publicLeakAttempt = { ...structuredClone(gaSigned), allowed_bases: ["validator", "public"] };
  assert.ok(validateSchema(publicLeakAttempt, schema).length > 0);

  const traversalAttempt = structuredClone(gaSigned);
  traversalAttempt.files[0].path = "../etc/passwd";
  assert.ok(validateSchema(traversalAttempt, schema).length > 0);

  for (const refusedPath of ["hub/.htaccess", ".env", "a//b.json", "a/./b.json", "models/"]) {
    const attempt = structuredClone(gaSigned);
    attempt.files[0].path = refusedPath;
    assert.ok(validateSchema(attempt, schema).length > 0, `schema must refuse path ${refusedPath}`);
  }
  for (const allowedPath of ["hub/coverage_manifest.json", "models/NVDA/outputs.v2.json", "assets/_shared/app-main.js"]) {
    const attempt = structuredClone(gaSigned);
    attempt.files[0].path = allowedPath;
    assert.deepEqual(validateSchema(attempt, schema), [], `schema must allow path ${allowedPath}`);
  }

  const unsafeVersion = { ...structuredClone(gaSigned), version: Number.MAX_SAFE_INTEGER + 1 };
  assert.ok(validateSchema(unsafeVersion, schema).length > 0);

  const expiredSigned = signPublishPayload({
    ...baseUnsigned, version: 44, nonce: "nonce_ga_models_expired_v44_123456",
    issued_at: "2026-11-27T01:00:00Z", expires_at: "2026-11-27T01:05:00Z",
  }, { algorithm: "ed25519", keyId: "ga-models-ed25519-k1", privateKey: edKeys.privateKey });
  assert.equal(verifyPublishPayload(expiredSigned, { keyRing, currentVersion: 43, seenNonces, nowMs }).error, "issued_at_out_of_window");

  const gaSigner = { algorithm: "ed25519", keyId: "ga-models-ed25519-k1", privateKey: edKeys.privateKey };
  const contentSigned = signPublishPayload({ ...baseUnsigned, version: 45, nonce: "nonce_ga_models_content_v45_123456" }, gaSigner);
  const swappedContent = structuredClone(contentSigned);
  swappedContent.files[0].content_base64 = Buffer.alloc(indexHtml.length, "x").toString("base64");
  assert.equal(verifyPublishPayload(swappedContent, { keyRing, currentVersion: 44, seenNonces, nowMs }).error, "file_hash_mismatch");
  const resizedContent = structuredClone(contentSigned);
  resizedContent.files[0].content_base64 = Buffer.from("<script>alert(1)</script>", "utf8").toString("base64");
  assert.equal(verifyPublishPayload(resizedContent, { keyRing, currentVersion: 44, seenNonces, nowMs }).error, "file_size_mismatch");

  const wrongTotalSigned = signPublishPayload({
    ...baseUnsigned, version: 45, nonce: "nonce_ga_models_total_v45_12345678", total_bytes: indexHtml.length + 1,
  }, gaSigner);
  assert.equal(verifyPublishPayload(wrongTotalSigned, { keyRing, currentVersion: 44, seenNonces, nowMs }).error, "total_bytes_mismatch");

  const duplicatePathSigned = signPublishPayload({
    ...baseUnsigned, version: 45, nonce: "nonce_ga_models_duplicate_v45_1234", total_bytes: indexHtml.length * 2,
    files: [baseUnsigned.files[0], baseUnsigned.files[0]], render_gate: { ...baseUnsigned.render_gate, file_count: 2 },
  }, gaSigner);
  assert.equal(verifyPublishPayload(duplicatePathSigned, { keyRing, currentVersion: 44, seenNonces, nowMs }).error, "duplicate_file_path");

  const wrongAlgorithmSigned = signPublishPayload({
    ...baseUnsigned, version: 45, nonce: "nonce_ga_models_algorithm_v45_1234",
  }, { algorithm: "hmac-sha256", keyId: "ga-models-ed25519-k1", hmacSecret });
  assert.equal(verifyPublishPayload(wrongAlgorithmSigned, { keyRing, currentVersion: 44, seenNonces, nowMs }).error, "unknown_or_mismatched_key");
});

test("canonical-json-v1 reproduces the known-answer vector and refuses values it cannot encode", () => {
  const vector = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "finance-hub-publish-signing-vector.json"), "utf8"));
  const signing = buildPublishSigningMessage(vector.payload);
  assert.equal(signing.manifestSha256, vector.manifest_sha256);
  assert.equal(signing.payloadSha256, vector.payload_sha256);
  assert.equal(signing.message, vector.signing_message);
  assert.equal(Buffer.from(signing.canonicalFiles, "utf8").toString("hex"), vector.canonical_files_hex);
  assert.equal(Buffer.from(signing.canonicalEnvelope, "utf8").toString("hex"), vector.canonical_envelope_hex);

  const reordered = { ...vector.payload, files: [...vector.payload.files].reverse() };
  assert.equal(buildPublishSigningMessage(reordered).payloadSha256, vector.payload_sha256);

  assert.equal(canonicalJson({ b: null, a: [true, 0] }), '{"a":[true,0],"b":null}');
  for (const unencodable of [1.5, -1, Number.MAX_SAFE_INTEGER + 1, "\ud800", undefined]) {
    assert.throws(() => canonicalJson([unencodable]), TypeError);
  }
});

test("top30_snapshot.v1 enforces leaderboard formula, tie-breaks, non-validator seats, rank-35 hysteresis, and 7d grace", () => {
  const schema = loadSchema("top30_snapshot.v1.schema.json");
  const valid = goldenTop30Snapshot();
  assert.deepEqual(validateSchema(valid, schema), []);

  const leaderboardSrc = readFileSync(path.join(ROOT, "server", "repositories", "directory-leaderboard.js"), "utf8");
  assert.match(leaderboardSrc, /DIRECTORY_LEADERBOARD_NETWORK_TASK_WEIGHT \|\| 3/);
  assert.match(leaderboardSrc, /DIRECTORY_LEADERBOARD_PERSONAL_TASK_WEIGHT \|\| 1/);
  assert.match(leaderboardSrc, /DIRECTORY_LEADERBOARD_REWARD_DIVISOR \|\| 25_000/);
  assert.match(leaderboardSrc, /DIRECTORY_LEADERBOARD_ALIGNMENT_WEIGHT \|\| 1/);
  assert.match(leaderboardSrc, /3x network tasks \+ personal tasks \+ rewards\/25000 \+ alignment/);

  const [, beta, gamma] = valid.entries;
  assert.equal(beta.score, gamma.score);
  assert.equal(beta.is_public_profile, false);
  assert.ok(beta.account_id < gamma.account_id && beta.rank < gamma.rank);

  const graceEntry = valid.entries.find((item) => item.entitlement_state === "grace_7d");
  assert.equal(Date.parse(graceEntry.grace_ends_at) - Date.parse(graceEntry.grace_started_at), 7 * 86_400_000);
  assert.equal(Date.parse(graceEntry.grace_cooldown_until) - Date.parse(graceEntry.grace_started_at), 30 * 86_400_000);

  const validatorSeat = structuredClone(valid);
  validatorSeat.entries[0].is_active_validator = true;
  assert.ok(validateSchema(validatorSeat, schema).length > 0);

  const badSeated = structuredClone(valid);
  badSeated.entries[0].rank = 31;
  assert.ok(validateSchema(badSeated, schema).length > 0);

  const badHysteresis = structuredClone(valid);
  badHysteresis.entries[3].rank = 36;
  assert.ok(validateSchema(badHysteresis, schema).length > 0);

  const missingGraceExpiry = structuredClone(valid);
  missingGraceExpiry.entries[4].grace_ends_at = null;
  assert.ok(validateSchema(missingGraceExpiry, schema).length > 0);

  const badPolicy = structuredClone(valid);
  badPolicy.policy.keep_until_rank = 30;
  assert.ok(validateSchema(badPolicy, schema).length > 0);
});

test("Pillar 6 Nostr browser signing guard policy blocks derivation spoofing and untrusted events", () => {
  const REQUIRED_PREFIX = Object.freeze({
    nostr_v1_derivation: "Task Node private messaging identity",
    collaboration_auth: "Task Node collaboration authorization",
    wallet_proof: "Post Fiat Task Node wallet proof",
    wallet_login: "Post Fiat Task Node wallet login",
    task_transition: "Post Fiat Task Node task transition",
  });
  const ALLOWED_NOSTR_KINDS = new Set([0, 1, 13, 1059, 10050, 22242]);
  const nostrSpec = readFileSync(path.join(ROOT, "docs", "specs", "nostr-signing-guard-v1.md"), "utf8");
  const walletProofRow = nostrSpec.split("\n").find((line) => line.startsWith("| `wallet_proof` |"));
  const WALLET_PROOF_PURPOSES = JSON.parse(walletProofRow.match(/`Purpose:` in `(\[[^\]]*\])`/)[1]);
  const walletProofChallenge = (proofPurpose) => [
    "Post Fiat Task Node wallet proof", `Purpose: ${proofPurpose}`, "Account: acct_1",
    "Challenge: 3f0c2a52-7d1e-4a55-9a43-0d6f5b1c2e90", "Issued: 2026-11-27T01:30:00.000Z", "Expires: 2026-11-27T01:40:00.000Z",
  ].join("\n");

  function evaluateWalletSigningGuard({ purpose, message }) {
    if (!Object.hasOwn(REQUIRED_PREFIX, purpose)) return { ok: false, error: "SIGNING_GUARD_UNKNOWN_PURPOSE" };
    if (typeof message !== "string" || message.length === 0) return { ok: false, error: "SIGNING_GUARD_MALFORMED_MESSAGE" };
    const firstCode = message.charCodeAt(0);
    if (firstCode <= 0x20 || firstCode === 0xfeff || message.includes("\r") || message.includes("\0")) {
      return { ok: false, error: "SIGNING_GUARD_MALFORMED_MESSAGE" };
    }
    if (purpose !== "nostr_v1_derivation" && message.normalize("NFKC").toLowerCase().includes("task node private messaging identity")) {
      return { ok: false, error: "SIGNING_GUARD_FORBIDDEN_DERIVATION_PREFIX" };
    }
    if (!message.startsWith(`${REQUIRED_PREFIX[purpose]}\n`)) return { ok: false, error: "SIGNING_GUARD_PREFIX_MISMATCH" };
    if (purpose === "wallet_proof") {
      const proofPurpose = message.split("\n")[1].replace(/^Purpose: /, "");
      if (!WALLET_PROOF_PURPOSES.includes(proofPurpose)) return { ok: false, error: "SIGNING_GUARD_PREFIX_MISMATCH" };
    }
    return { ok: true };
  }

  function evaluateNostrEventGuard({ kind, origin, isProduction, relayUrl }) {
    if (origin !== "first_party_ui") return { ok: false, error: "NOSTR_SIGNING_GUARD_UNTRUSTED_ORIGIN" };
    if (!ALLOWED_NOSTR_KINDS.has(kind)) return { ok: false, error: "NOSTR_SIGNING_GUARD_KIND_BLOCKED" };
    if (kind === 0 && !isProduction) return { ok: false, error: "NOSTR_SIGNING_GUARD_NONPROD_KIND0_BLOCKED" };
    if (relayUrl && !/^wss:\/\/[a-z0-9.-]+(?::[0-9]{2,5})?(?:\/[^\s]*)?$/i.test(relayUrl)) return { ok: false, error: "NOSTR_SIGNING_GUARD_INVALID_RELAY" };
    return { ok: true };
  }

  assert.deepEqual(evaluateWalletSigningGuard({ purpose: "collaboration_auth", message: "Task Node collaboration authorization\nAction: post\nAccount: acct_1" }), { ok: true });
  assert.deepEqual(evaluateWalletSigningGuard({ purpose: "nostr_v1_derivation", message: "Task Node private messaging identity\nVersion: 1\nAccount: acct_1" }), { ok: true });
  assert.equal(evaluateWalletSigningGuard({ purpose: "collaboration_auth", message: "Task Node private messaging identity\nVersion: 1\nAccount: acct_1" }).error, "SIGNING_GUARD_FORBIDDEN_DERIVATION_PREFIX");
  assert.equal(evaluateWalletSigningGuard({ purpose: "collaboration_auth", message: "\uFEFFTask Node private messaging identity\nVersion: 1" }).error, "SIGNING_GUARD_MALFORMED_MESSAGE");
  assert.equal(evaluateWalletSigningGuard({ purpose: "wallet_proof", message: "Post Fiat Task Node wallet proof\nTask Node private messaging identity" }).error, "SIGNING_GUARD_FORBIDDEN_DERIVATION_PREFIX");

  const issuedProofPurposes = serverWalletProofPurposes();
  assert.deepEqual([...WALLET_PROOF_PURPOSES].sort(), issuedProofPurposes, "the wallet_proof allow-list must equal the purposes the server issues");
  for (const proofPurpose of issuedProofPurposes) {
    assert.deepEqual(evaluateWalletSigningGuard({ purpose: "wallet_proof", message: walletProofChallenge(proofPurpose) }), { ok: true }, `guard must accept ${proofPurpose}`);
  }
  assert.equal(evaluateWalletSigningGuard({ purpose: "wallet_proof", message: walletProofChallenge("wallet_export") }).error, "SIGNING_GUARD_PREFIX_MISMATCH");

  assert.equal(evaluateNostrEventGuard({ kind: 24133, origin: "first_party_ui", isProduction: true }).error, "NOSTR_SIGNING_GUARD_KIND_BLOCKED");
  assert.equal(evaluateNostrEventGuard({ kind: 1, origin: "postMessage:hub-viewer.postfiat.org", isProduction: true }).error, "NOSTR_SIGNING_GUARD_UNTRUSTED_ORIGIN");
  assert.equal(evaluateNostrEventGuard({ kind: 0, origin: "first_party_ui", isProduction: false }).error, "NOSTR_SIGNING_GUARD_NONPROD_KIND0_BLOCKED");
  assert.equal(evaluateNostrEventGuard({ kind: 22242, origin: "first_party_ui", isProduction: true, relayUrl: "ws://insecure.example" }).error, "NOSTR_SIGNING_GUARD_INVALID_RELAY");
  assert.deepEqual(evaluateNostrEventGuard({ kind: 22242, origin: "first_party_ui", isProduction: true, relayUrl: "wss://relay.postfiat.org" }), { ok: true });

  const hubSpec = readFileSync(path.join(ROOT, "docs", "specs", "finance-hub-contracts-v1.md"), "utf8");
  for (const ref of ["coverage_manifest.v1.schema.json", "agent_brief_public.v1.schema.json", "publish_payload.v1.schema.json", "top30_snapshot.v1.schema.json"]) {
    assert.match(hubSpec, new RegExp(ref.replaceAll(".", "\\.")));
  }
  assert.match(nostrSpec, /Task Node collaboration authorization/);
  assert.match(nostrSpec, /Task Node private messaging identity/);
  assert.match(nostrSpec, /SIGNING_GUARD_FORBIDDEN_DERIVATION_PREFIX/);
  assert.match(nostrSpec, /NOSTR_SIGNING_GUARD_KIND_BLOCKED/);
});
