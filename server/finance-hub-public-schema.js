// Public Finance Hub artifacts must match their locked PR 446 contract schemas
// (Draft 2020-12, additionalProperties:false) at API ingress, not only by the
// producer's own assertion. The validator covers the keywords those schemas use.
import { readFileSync } from "node:fs";

const SCHEMA_DIR = new URL("../schemas/finance-hub/", import.meta.url);
const loadSchema = (name) => JSON.parse(readFileSync(new URL(name, SCHEMA_DIR), "utf8"));
const SCHEMAS = {
  brief: loadSchema("agent_brief_public.v1.schema.json"),
  coverage: loadSchema("coverage_manifest.v1.schema.json"),
};
const BRIEF_PATH = /^public\/briefs\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.json$/;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function resolveRef(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
  return ref.slice(2).split("/").reduce((node, part) => node?.[part], root);
}

export function validateAgainstSchema(value, schema, root = schema, at = "$") {
  if (!schema) return [`${at}: unresolved schema`];
  if (schema.$ref) return validateAgainstSchema(value, resolveRef(root, schema.$ref), root, at);
  const errors = [];
  if (schema.type !== undefined) {
    const allowed = [].concat(schema.type);
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === "integer" && allowed.includes("number"))) return [`${at}: expected ${allowed.join("|")}`];
  }
  if (Object.hasOwn(schema, "const") && canonical(value) !== canonical(schema.const)) errors.push(`${at}: const mismatch`);
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => canonical(entry) === canonical(value))) errors.push(`${at}: not in enum`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: too long`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: pattern mismatch`);
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(value))) errors.push(`${at}: invalid date-time`);
    if (schema.format === "uri" && !URL.canParse(value)) errors.push(`${at}: invalid uri`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: too many items`);
    if (schema.uniqueItems && new Set(value.map(canonical)).size !== value.length) errors.push(`${at}: duplicate items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validateAgainstSchema(item, schema.items, root, `${at}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${at}: missing ${key}`);
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) errors.push(...validateAgainstSchema(entry, properties[key], root, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property ${key}`);
    }
  }
  for (const sub of schema.allOf || []) errors.push(...validateAgainstSchema(value, sub, root, at));
  if (schema.if) {
    const matches = validateAgainstSchema(value, schema.if, root, at).length === 0;
    const branch = matches ? schema.then : schema.else;
    if (branch) errors.push(...validateAgainstSchema(value, branch, root, at));
  }
  return errors;
}

/**
 * Errors for a JSON artifact published to `finance-hub-public`: briefs and the
 * coverage manifest must match their schema; other JSON under `public/` or
 * `hub/` has no contract and is refused.
 */
export function publicArtifactErrors(filePath, doc) {
  const brief = BRIEF_PATH.exec(filePath);
  if (brief) {
    const errors = validateAgainstSchema(doc, SCHEMAS.brief);
    if (!errors.length && doc.model_id !== brief[1]) errors.push("$.model_id: does not match the file name");
    return errors;
  }
  if (filePath === "hub/coverage_manifest.json") return validateAgainstSchema(doc, SCHEMAS.coverage);
  if (filePath.startsWith("public/") || filePath.startsWith("hub/")) return ["$: no public contract for this path"];
  return [];
}
