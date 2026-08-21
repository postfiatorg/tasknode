const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const parsedJsonBody = Symbol("tasknode.parsedJsonBody");

function failure(code, path = "body") {
  const error = new Error(code);
  error.status = 400;
  error.field = path;
  return error;
}

function valueType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function validateShape(value, schema, path) {
  if (!schema) return;
  const actual = valueType(value);
  const accepted = Array.isArray(schema.type) ? schema.type : [schema.type || "string"];
  if (!accepted.includes(actual) && !(actual === "integer" && accepted.includes("number"))) {
    throw failure("request_body_field_type_invalid", path);
  }
  if (typeof value === "string") {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) throw failure("request_body_field_too_short", path);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) throw failure("request_body_field_too_long", path);
    if (schema.pattern && !schema.pattern.test(value)) throw failure("request_body_field_format_invalid", path);
    if (schema.enum && !schema.enum.includes(value)) throw failure("request_body_field_value_invalid", path);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw failure("request_body_field_number_invalid", path);
    if (Number.isFinite(schema.minimum) && value < schema.minimum) throw failure("request_body_field_number_too_small", path);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) throw failure("request_body_field_number_too_large", path);
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) throw failure("request_body_array_too_large", path);
    value.forEach((entry, index) => validateShape(entry, schema.items, `${path}[${index}]`));
  }
  if (actual === "object") {
    validateObjectSchema(value, schema, path);
  }
}

function validateObjectSchema(value, schema, path = "body") {
  const properties = schema.properties || {};
  for (const field of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) throw failure("request_body_field_required", `${path}.${field}`);
  }
  for (const group of schema.requiredAny || []) {
    if (!group.some((field) => Object.prototype.hasOwnProperty.call(value, field))) {
      throw failure("request_body_field_required", `${path}.${group.join("|")}`);
    }
  }
  for (const [field, entry] of Object.entries(value)) {
    if (forbiddenKeys.has(field)) throw failure("request_body_key_forbidden", `${path}.${field}`);
    if (properties[field]) validateShape(entry, properties[field], `${path}.${field}`);
    else if (schema.allowUnknown === false) throw failure("request_body_field_unknown", `${path}.${field}`);
  }
}

export function validateJsonDocument(value, schema = null, { maxDepth = 20, maxNodes = 50_000 } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("request_body_object_required");
  let nodes = 0;
  const visit = (entry, depth, path) => {
    nodes += 1;
    if (nodes > maxNodes) throw failure("request_body_too_complex", path);
    if (depth > maxDepth) throw failure("request_body_too_deep", path);
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, depth + 1, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(entry)) {
      if (forbiddenKeys.has(key)) throw failure("request_body_key_forbidden", `${path}.${key}`);
      visit(child, depth + 1, `${path}.${key}`);
    }
  };
  visit(value, 0, "body");
  if (schema) validateObjectSchema(value, { type: "object", ...schema });
  return value;
}

export function bodyPolicy(maxBytes, schema = {}) {
  return Object.freeze({ maxBytes, schema: Object.freeze({ type: "object", allowUnknown: true, ...schema }) });
}

export async function readValidatedJson(req, maxBytes = 16_384, schema = null) {
  if (req[parsedJsonBody]) {
    if (req[parsedJsonBody].bytes > maxBytes) {
      const error = new Error("request_too_large");
      error.status = 413;
      throw error;
    }
    return validateJsonDocument(req[parsedJsonBody].value, schema);
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("request_too_large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    const value = {};
    req[parsedJsonBody] = { bytes: 0, value };
    return validateJsonDocument(value, schema);
  }

  const contentType = String(req.headers?.["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType && contentType !== "application/json" && !contentType.endsWith("+json")) {
    const error = new Error("unsupported_media_type");
    error.status = 415;
    throw error;
  }

  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (_error) {
    const parseError = new Error("invalid_json");
    parseError.status = 400;
    throw parseError;
  }
  req[parsedJsonBody] = { bytes: total, value };
  return validateJsonDocument(value, schema);
}
