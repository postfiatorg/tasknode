#!/usr/bin/env node

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { bodyPolicy, readValidatedJson, validateJsonDocument } from "../server/request-validation.js";
import {
  apiRoutePolicies,
  routeBodyPolicyForRequest,
  routeHasMutation,
} from "../server/route-policies.js";

const schema = {
  allowUnknown: false,
  required: ["name", "enabled"],
  requiredAny: [["publicKey", "public_key"]],
  properties: {
    name: { type: "string", minLength: 2, maxLength: 12, pattern: /^[a-z]+$/ },
    enabled: { type: "boolean" },
    publicKey: { type: "string", minLength: 4, maxLength: 12 },
    public_key: { type: "string", minLength: 4, maxLength: 12 },
    tags: { type: "array", maxItems: 2, items: { type: "string", maxLength: 8 } },
    settings: {
      type: "object",
      allowUnknown: false,
      properties: { retries: { type: "integer", minimum: 0, maximum: 5 } },
    },
  },
};

const valid = { name: "alice", enabled: true, public_key: "abcd", tags: ["one"], settings: { retries: 2 } };
assert.deepEqual(validateJsonDocument(valid, schema), valid);

const rejects = [
  [{ enabled: true, publicKey: "abcd" }, "request_body_field_required"],
  [{ name: "alice", enabled: true }, "request_body_field_required"],
  [{ name: "A", enabled: true, publicKey: "abcd" }, "request_body_field_too_short"],
  [{ name: "ALICE", enabled: true, publicKey: "abcd" }, "request_body_field_format_invalid"],
  [{ name: "alice", enabled: "yes", publicKey: "abcd" }, "request_body_field_type_invalid"],
  [{ name: "alice", enabled: true, publicKey: "abcd", extra: true }, "request_body_field_unknown"],
  [{ name: "alice", enabled: true, publicKey: "abcd", tags: ["one", "two", "three"] }, "request_body_array_too_large"],
  [{ name: "alice", enabled: true, publicKey: "abcd", settings: { retries: 6 } }, "request_body_field_number_too_large"],
];
for (const [value, code] of rejects) assert.throws(() => validateJsonDocument(value, schema), new RegExp(code));

const polluted = JSON.parse('{"safe":{"__proto__":{"admin":true}}}');
assert.throws(() => validateJsonDocument(polluted), /request_body_key_forbidden/);
assert.throws(() => validateJsonDocument({ safe: { constructor: "nope" } }), /request_body_key_forbidden/);
assert.throws(() => validateJsonDocument({ nested: { more: { value: true } } }, null, { maxDepth: 2 }), /request_body_too_deep/);
assert.throws(() => validateJsonDocument({ values: [1, 2, 3] }, null, { maxNodes: 3 }), /request_body_too_complex/);
assert.throws(() => validateJsonDocument(["not", "an", "object"]), /request_body_object_required/);

const policy = bodyPolicy(4096, schema);
assert.equal(policy.maxBytes, 4096);
assert.equal(policy.schema.type, "object");
assert.equal(policy.schema.allowUnknown, false);

function request(body, contentType = "application/json") {
  const req = Readable.from(body === null ? [] : [Buffer.from(body)]);
  req.headers = contentType ? { "content-type": contentType } : {};
  return req;
}

function schemaFixture(schema = {}) {
  const accepted = Array.isArray(schema.type) ? schema.type : [schema.type || "string"];
  const type = accepted.find((candidate) => candidate !== "null") || "null";
  if (type === "boolean") return true;
  if (type === "integer" || type === "number") return Number.isFinite(schema.minimum) ? schema.minimum : 0;
  if (type === "array") return [];
  if (type === "object") {
    const value = {};
    for (const field of schema.required || []) value[field] = schemaFixture(schema.properties?.[field]);
    for (const group of schema.requiredAny || []) {
      if (group.some((field) => Object.hasOwn(value, field))) continue;
      const field = group[0];
      value[field] = schemaFixture(schema.properties?.[field]);
    }
    return value;
  }
  if (schema.enum?.length) return schema.enum[0];
  return "x".repeat(Math.max(0, Number(schema.minLength) || 0));
}

const validRequest = request('{"name":"alice","enabled":true,"publicKey":"abcd"}', "application/problem+json; charset=utf-8");
assert.equal((await readValidatedJson(validRequest, 1024, schema)).name, "alice");
await assert.rejects(() => readValidatedJson(validRequest, 8, schema), (error) => error.message === "request_too_large" && error.status === 413);

await assert.rejects(() => readValidatedJson(request("not-json"), 1024), (error) => error.message === "invalid_json" && error.status === 400);
await assert.rejects(() => readValidatedJson(request("[]"), 1024), (error) => error.message === "request_body_object_required" && error.status === 400);
await assert.rejects(
  () => readValidatedJson(request('{"name":"alice","enabled":"yes","publicKey":"abcd"}'), 1024, schema),
  (error) => error.message === "request_body_field_type_invalid" && error.field === "body.enabled"
);
await assert.rejects(() => readValidatedJson(request("{}", "text/plain"), 1024), (error) => error.message === "unsupported_media_type" && error.status === 415);
assert.deepEqual(await readValidatedJson(request(null), 1024), {});

const ids = new Set();
let mutationPolicyCount = 0;
for (const route of apiRoutePolicies) {
  assert.ok(route.id && !ids.has(route.id), `duplicate route policy id: ${route.id}`);
  ids.add(route.id);
  if (!routeHasMutation(route)) continue;
  mutationPolicyCount += 1;
  assert.ok(route.body || route.bodies || route.bodyRoutes, `${route.id} must fail closed behind a mutation body contract`);

  const declaredBodies = [
    route.body,
    ...Object.values(route.bodies || {}),
    ...(route.bodyRoutes || []).map((entry) => entry.body),
  ].filter(Boolean);
  for (const declared of declaredBodies) {
    assert.ok(Number.isInteger(declared.maxBytes) && declared.maxBytes > 0, `${route.id} must declare a finite body limit`);
    assert.equal(declared.schema.type, "object", `${route.id} must accept a JSON object`);
    if (route.id !== "telegram_bot_webhook") {
      assert.equal(declared.schema.allowUnknown, false, `${route.id} must reject undeclared top-level fields`);
      const validFixture = schemaFixture(declared.schema);
      assert.deepEqual(validateJsonDocument(validFixture, declared.schema), validFixture, `${route.id} schema must accept its declared minimum shape`);
      assert.throws(
        () => validateJsonDocument({ ...validFixture, unexpectedContractBypass: true }, declared.schema),
        /request_body_field_unknown/,
        `${route.id} must reject adjacent undeclared fields`
      );
    }
  }

  if (route.path) {
    for (const method of route.methods.filter((candidate) => ["POST", "PUT", "PATCH", "DELETE"].includes(candidate))) {
      assert.ok(routeBodyPolicyForRequest(route, method, route.path), `${route.id} ${method} must resolve a body contract`);
    }
  }
  for (const pathname of route.paths || []) {
    for (const method of route.methods.filter((candidate) => ["POST", "PUT", "PATCH", "DELETE"].includes(candidate))) {
      assert.ok(routeBodyPolicyForRequest(route, method, pathname), `${route.id} ${method} ${pathname} must resolve a body contract`);
    }
  }
  for (const bodyRoute of route.bodyRoutes || []) {
    const methods = bodyRoute.methods || [bodyRoute.method || "POST"];
    for (const method of methods) {
      assert.ok(routeBodyPolicyForRequest(route, method, bodyRoute.path), `${route.id} ${method} ${bodyRoute.path} must resolve its routed body contract`);
    }
  }
}

for (const routeId of [
  "auth_email_start",
  "auth_email_verify",
  "auth_wallet_start",
  "auth_wallet_verify",
  "account_delete",
  "account_unlink_provider",
]) {
  const route = apiRoutePolicies.find((candidate) => candidate.id === routeId);
  assert.ok(route?.body?.schema?.required?.length, `${routeId} must retain a typed body contract`);
}

for (const routeId of ["task_action", "task_submission"]) {
  const route = apiRoutePolicies.find((candidate) => candidate.id === routeId);
  const contract = routeBodyPolicyForRequest(route, "POST", route.path);
  const directOffchainPayload = {
    phase: "submit",
    taskId: "task_contract_smoke",
    ...(routeId === "task_action" ? { taskAction: "accept" } : {}),
    offchainPayload: {
      schema: routeId === "task_action" ? "pf.task.update.v1" : "pf.task.submission.v1",
      task_id: "task_contract_smoke",
    },
    actorSignature: null,
  };
  assert.deepEqual(
    validateJsonDocument(directOffchainPayload, contract.schema),
    directOffchainPayload,
    `${routeId} must accept an intentionally unsigned direct-offchain mutation`
  );
  assert.throws(
    () => validateJsonDocument({ ...directOffchainPayload, actorSignature: "invalid" }, contract.schema),
    /request_body_field_type_invalid/,
    `${routeId} must still reject malformed non-object signatures`
  );
}

assert.ok(mutationPolicyCount > 70, "the mutation inventory must not silently shrink");
console.log(`request validation smoke ok: ${apiRoutePolicies.length} route policies, ${mutationPolicyCount} fail-closed mutation policies`);
