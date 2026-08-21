import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  clientIp,
  requestHost,
  requestOriginFromBoundary,
  requestProtocol,
  trustedProxyConfig,
} from "../server/trusted-proxy.js";
import {
  checkRouteRateLimit,
  sharedRateLimitStartupIssues,
} from "../server/rate-limit.js";

function request({ remoteAddress, headers = {}, encrypted = false } = {}) {
  return { headers, socket: { remoteAddress, encrypted } };
}

const trustedEnv = { TASKNODE_TRUSTED_PROXY_CIDRS: "10.0.0.0/8,fd00::/8" };

assert.equal(clientIp(request({
  remoteAddress: "203.0.113.9",
  headers: { "x-forwarded-for": "198.51.100.44" },
}), trustedEnv), "203.0.113.9", "an untrusted caller must not choose its rate-limit identity");

assert.equal(clientIp(request({
  remoteAddress: "10.0.0.8",
  headers: { "x-forwarded-for": "192.0.2.250, 198.51.100.44" },
}), trustedEnv), "198.51.100.44", "a forged prefix must not override the nearest untrusted client hop");

assert.equal(clientIp(request({
  remoteAddress: "10.0.0.8",
  headers: { "x-forwarded-for": "198.51.100.44, 10.1.2.3" },
}), trustedEnv), "198.51.100.44", "known proxy hops must be traversed from right to left");

assert.equal(clientIp(request({
  remoteAddress: "10.0.0.8",
  headers: { "x-forwarded-for": "not-an-ip, 198.51.100.44" },
}), trustedEnv), "10.0.0.8", "a malformed chain must be ignored conservatively");

const untrustedForwarding = request({
  remoteAddress: "203.0.113.9",
  headers: {
    host: "app.example.test",
    "x-forwarded-host": "attacker.example",
    "x-forwarded-proto": "https",
  },
});
assert.equal(requestHost(untrustedForwarding, trustedEnv), "app.example.test");
assert.equal(requestProtocol(untrustedForwarding, trustedEnv), "http");

const trustedForwarding = request({
  remoteAddress: "fd00::10",
  headers: {
    host: "internal:8080",
    "x-forwarded-host": "public.example.test",
    "x-forwarded-proto": "https",
  },
});
assert.equal(requestHost(trustedForwarding, trustedEnv), "public.example.test");
assert.equal(requestProtocol(trustedForwarding, trustedEnv), "https");
assert.equal(requestOriginFromBoundary(trustedForwarding, trustedEnv), "https://public.example.test");
assert.deepEqual(trustedProxyConfig({ TASKNODE_TRUSTED_PROXY_CIDRS: "broken/999" }).invalid, ["broken/999"]);

assert.equal(sharedRateLimitStartupIssues({ TASKNODE_ENV: "production" })[0]?.code, "shared_rate_limit_store_required");
assert.deepEqual(sharedRateLimitStartupIssues({
  TASKNODE_ENV: "production",
  TASKNODE_DATABASE_ENABLED: "true",
  DATABASE_URL: "postgres://example.invalid/tasknode",
}), []);

await assert.rejects(
  checkRouteRateLimit({
    key: "login:account:198.51.100.44",
    route: "login",
    databaseReady: false,
    env: { TASKNODE_ENV: "production" },
  }),
  /shared_rate_limit_store_required/
);

let queryCall = null;
const shared = await checkRouteRateLimit({
  key: "login:account:198.51.100.44",
  route: "login",
  limit: 2,
  windowMs: 60_000,
  now: Date.parse("2026-08-15T12:00:00Z"),
  databaseReady: true,
  queryImpl: async (sql, params) => {
    queryCall = { sql, params };
    return { rows: [{ request_count: 3, limit_count: 2, reset_at: "2026-08-15T12:01:00Z" }] };
  },
});
assert.equal(shared.allowed, false);
assert.equal(shared.storage, "postgres");
assert.equal(shared.retryAfterSeconds, 60);
assert.match(queryCall.sql, /ON CONFLICT \(bucket_hash\) DO UPDATE/);
assert.match(queryCall.params[0], /^[a-f0-9]{64}$/);
assert.equal(queryCall.params.join(" ").includes("198.51.100.44"), false, "raw client identifiers must not be persisted");

const serverSources = await Promise.all([
  "../server/index.js",
  "../server/server-http-boundary.js",
].map((pathname) => readFile(new URL(pathname, import.meta.url), "utf8")));
const limiterCalls = serverSources.flatMap((source) => (
  source.split(/\r?\n/).filter((line) => line.includes("enforceRateLimit("))
));
assert.ok(limiterCalls.length >= 4, "the declaration and central/route-specific limiters must remain covered");
assert.equal(
  limiterCalls.filter((line) => !line.includes("function enforceRateLimit(") && !/await\s+enforceRateLimit\s*\(/.test(line)).length,
  0,
  "every enforceRateLimit invocation must await the shared asynchronous store"
);

console.log("trusted proxy and shared rate-limit smoke ok");
