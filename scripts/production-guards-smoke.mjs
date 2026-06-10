import assert from "node:assert/strict";

import {
  isProductionEnvironment,
  legacyHostRedirectTarget,
  moneySeedFromEnv,
  moneySeedStartupIssues,
  productionOriginIssues,
} from "../server/production-guards.js";

const PROD = "https://tasknode.postfiat.org";
const DEV_HOST = "tasknodeofficial-dev.fly.dev";

// Environment detection.
assert.equal(isProductionEnvironment({ TASKNODE_ENV: "production" }), true);
assert.equal(isProductionEnvironment({ NODE_ENV: "production" }), true);
assert.equal(isProductionEnvironment({ TASKNODE_ENV: "development" }), false);
assert.equal(isProductionEnvironment({}), false);

// Origin issues: consistent config is clean.
assert.deepEqual(
  productionOriginIssues({
    TASKNODE_PUBLIC_URL: PROD,
    VITE_SITE_ORIGIN: PROD,
    DISCORD_REDIRECT_URI: `${PROD}/api/auth/callback/discord`,
    X_REDIRECT_URI: `${PROD}/api/auth/callback/x`,
    TELEGRAM_AUTH_WIDGET_DOMAIN: "tasknode.postfiat.org",
  }),
  []
);

// Each stale dev-host value is reported.
const issues = productionOriginIssues({
  TASKNODE_PUBLIC_URL: PROD,
  VITE_SITE_ORIGIN: `https://${DEV_HOST}`,
  DISCORD_REDIRECT_URI: `https://${DEV_HOST}/api/auth/callback/discord`,
  X_REDIRECT_URI: `https://${DEV_HOST}/api/auth/callback/x`,
  TELEGRAM_AUTH_WIDGET_DOMAIN: DEV_HOST,
});
assert.deepEqual(
  issues.map((issue) => issue.code).sort(),
  [
    "discord_redirect_host_mismatch",
    "site_origin_host_mismatch",
    "telegram_widget_domain_mismatch",
    "x_redirect_host_mismatch",
  ]
);

// Unset optional values are not issues; no public origin means no checks.
assert.deepEqual(productionOriginIssues({ TASKNODE_PUBLIC_URL: PROD }), []);
assert.deepEqual(productionOriginIssues({}), []);

// Legacy host redirect: only configured hosts, only GET/HEAD, never health.
const redirectEnv = { TASKNODE_PUBLIC_URL: PROD, TASKNODE_LEGACY_REDIRECT_HOSTS: DEV_HOST };
assert.equal(
  legacyHostRedirectTarget({ host: DEV_HOST, pathname: "/wallet", search: "?tab=send", env: redirectEnv }),
  `${PROD}/wallet?tab=send`
);
assert.equal(
  legacyHostRedirectTarget({ host: `${DEV_HOST}:443`, pathname: "/", search: "", env: redirectEnv }),
  `${PROD}/`
);
assert.equal(legacyHostRedirectTarget({ host: DEV_HOST, pathname: "/health", search: "", env: redirectEnv }), "");
assert.equal(
  legacyHostRedirectTarget({ host: DEV_HOST, method: "POST", pathname: "/api/wallet/send", search: "", env: redirectEnv }),
  ""
);
assert.equal(
  legacyHostRedirectTarget({ host: "tasknode.postfiat.org", pathname: "/", search: "", env: redirectEnv }),
  ""
);
assert.equal(
  legacyHostRedirectTarget({ host: DEV_HOST, pathname: "/", search: "", env: { TASKNODE_PUBLIC_URL: PROD } }),
  "",
  "no redirect without explicit legacy host config"
);
assert.equal(
  legacyHostRedirectTarget({ host: DEV_HOST, pathname: "/", search: "", env: { TASKNODE_LEGACY_REDIRECT_HOSTS: DEV_HOST } }),
  "",
  "no redirect without a public origin to send users to"
);

// Money seeds: explicit primary always wins.
const seedKeys = {
  primaryKeys: ["TASKNODE_DAILY_AIRDROP_SEED"],
  fallbackKeys: ["TASKNODE_REWARD_SEED", "FAUCET_SEED"],
};
assert.deepEqual(
  moneySeedFromEnv({ env: { TASKNODE_DAILY_AIRDROP_SEED: "sPrimary" }, ...seedKeys }),
  { seed: "sPrimary", source: "TASKNODE_DAILY_AIRDROP_SEED", fallback: false }
);

// Development keeps the fallback chain for convenience.
assert.deepEqual(
  moneySeedFromEnv({ env: { FAUCET_SEED: "sFaucet" }, ...seedKeys }),
  { seed: "sFaucet", source: "FAUCET_SEED", fallback: true }
);

// Production refuses to fall back: missing primary means no seed at all.
assert.deepEqual(
  moneySeedFromEnv({ env: { TASKNODE_ENV: "production", FAUCET_SEED: "sFaucet" }, ...seedKeys }),
  { seed: "", source: "", fallback: false }
);
assert.deepEqual(
  moneySeedFromEnv({ env: { TASKNODE_ENV: "production", TASKNODE_DAILY_AIRDROP_SEED: "sPrimary" }, ...seedKeys }),
  { seed: "sPrimary", source: "TASKNODE_DAILY_AIRDROP_SEED", fallback: false }
);

// Startup issues fire only for enabled workers in production with missing seeds.
assert.deepEqual(
  moneySeedStartupIssues({
    TASKNODE_ENV: "production",
    TASKNODE_TASK_REVIEW_WORKER_ENABLED: "true",
    TASKNODE_DAILY_AIRDROP_WORKER_ENABLED: "true",
  }).map((issue) => issue.code),
  ["reward_seed_not_explicit", "daily_airdrop_seed_not_explicit"]
);
assert.deepEqual(
  moneySeedStartupIssues({
    TASKNODE_ENV: "production",
    TASKNODE_TASK_REVIEW_WORKER_ENABLED: "true",
    TASKNODE_DAILY_AIRDROP_WORKER_ENABLED: "true",
    TASKNODE_REWARD_SEED: "sReward",
    TASKNODE_DAILY_AIRDROP_SEED: "sAirdrop",
  }),
  []
);
assert.deepEqual(moneySeedStartupIssues({ TASKNODE_ENV: "development" }), []);

console.log("production guards smoke ok");
