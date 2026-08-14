import assert from "node:assert/strict";

const { generateIChingProfile } = await import("../server/i-ching-profile.js");
const {
  getIChingProfile,
  iChingProfilePromptPayload,
  upsertIChingProfile,
} = await import("../server/repositories/i-ching-profile.js");
const { taskNodeInstructions } = await import("../server/chat-memory-context.js");
const { handleIChingRoute } = await import("../server/i-ching-routes.js");

const accountId = `i-ching-profile-smoke-${Date.now()}`;
const chart = await generateIChingProfile({
  birthDate: "1988-03-15",
  birthTime: "14:30",
  birthLocation: "39.9526,-75.1652",
  gender: "male",
});

assert.equal(chart.input.timezone, "America/New_York");
assert.match(chart.input.true_solar_time, /^\d{2}:\d{2}:\d{2}$/);
assert.deepEqual(Object.keys(chart.bazi.four_pillars), ["year", "month", "day", "hour"]);
assert.ok(Object.values(chart.bazi.four_pillars).every(Boolean));
assert.ok(chart.bazi.day_master);
assert.equal(chart.ziwei.chart.palaces.length, 12);
assert.deepEqual(chart.combined.bazi, chart.bazi);

const saved = await upsertIChingProfile({ accountId, chart });
assert.equal(saved.accountId, accountId);
assert.equal(saved.birthLocation, "39.9526,-75.1652");
assert.equal((await getIChingProfile({ accountId }))?.bazi?.day_master, chart.bazi.day_master);
assert.equal(await getIChingProfile({ accountId: `${accountId}-other` }), null, "profiles must remain account-scoped");

const routeResponse = {};
const json = (res, status, body) => Object.assign(res, { status, body });
assert.equal(await handleIChingRoute({
  json,
  readJson: async () => ({}),
  req: { method: "GET" },
  res: routeResponse,
  session: null,
  url: new URL("http://tasknode.local/api/i-ching/profile"),
}), true);
assert.equal(routeResponse.status, 401);
assert.equal(routeResponse.body.error, "i_ching_login_required");

const isolatedResponse = {};
await handleIChingRoute({
  json,
  readJson: async () => ({}),
  req: { method: "GET" },
  res: isolatedResponse,
  session: { accountId: `${accountId}-other` },
  url: new URL("http://tasknode.local/api/i-ching/profile"),
});
assert.equal(isolatedResponse.status, 200);
assert.equal(isolatedResponse.body.exists, false);

const postResponse = {};
await handleIChingRoute({
  json,
  readJson: async () => ({
    birthDate: "1992-11-07",
    birthTime: "08:45",
    birthLocation: "34.0522,-118.2437",
    gender: "female",
  }),
  req: { method: "POST" },
  res: postResponse,
  session: { accountId: `${accountId}-route` },
  url: new URL("http://tasknode.local/api/i-ching/profile"),
});
assert.equal(postResponse.status, 200);
assert.equal(postResponse.body.exists, true);
assert.equal(postResponse.body.profile.timezone, "America/Los_Angeles");
assert.equal(postResponse.body.profile.bazi, undefined, "the route must not return the computed chart payload");
assert.equal(postResponse.body.profile.ziwei, undefined, "the route must not return the computed chart payload");

const promptPayload = iChingProfilePromptPayload(saved);
const instructions = taskNodeInstructions({
  message: "What should I prioritize next?",
  persona: "i-ching",
  iChingProfile: promptPayload,
});
assert.match(instructions, new RegExp(chart.bazi.day_master));
assert.match(instructions, /America\/New_York/);
assert.doesNotMatch(instructions, /No stored birth-chart payload/);
assert.doesNotMatch(instructions, /___[A-Z0-9_]+___/);

await assert.rejects(
  generateIChingProfile({
    birthDate: "1988-03-15",
    birthTime: "14:30",
    birthLocation: "39.9526,-75.1652",
    gender: "unspecified",
  }),
  /Gender must be male or female/
);
await assert.rejects(
  generateIChingProfile({
    birthDate: "2999-03-15",
    birthTime: "14:30",
    birthLocation: "39.9526,-75.1652",
    gender: "female",
  }),
  /Birth date or time is invalid/
);

console.log("i ching profile smoke ok");
