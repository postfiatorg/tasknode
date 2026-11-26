import assert from "node:assert/strict";
import test from "node:test";
import { boardDiscordEvidence, discordMessageLinks } from "../server/board-discord-evidence.js";

const url = "https://discord.com/channels/1061800464045310053/1546231723682041916/1571631988396523651";
const env = { DISCORD_BOT_TOKEN: "fixture-token" };
const queryImpl = async () => ({ rows: [{ identity_json: { username: "Walker", displayName: "W" } }] });
const reply = (status, body = {}) => async (requested, init) => {
  assert.ok(String(requested).endsWith("/channels/1546231723682041916/messages/1571631988396523651"));
  assert.equal(init.headers.authorization, "Bot fixture-token");
  return new Response(JSON.stringify(body), { status });
};
const input = { accountId: "acct_a", taskCreatedAt: "2026-11-15T03:57:22.909Z", payloads: [{ evidence_items: [{ value: `Announced here: ${url}. PR merged.` }] }] };

test("finds each Discord message link once, wherever it sits in the payload", () => {
  assert.deepEqual(discordMessageLinks({ a: `see ${url}`, b: [`(${url})`] }, "no link here").map((link) => link.messageId), ["1571631988396523651"]);
  assert.deepEqual(discordMessageLinks("https://discord.gg/invite and https://example.com/channels/1/2/3"), []);
});

test("verified only when the linked account posted it after the task was created", async () => {
  const message = { author: { username: "walker" }, timestamp: "2026-11-15T21:04:25.544000+00:00", content: "Completed Network Task." };
  const ok = await boardDiscordEvidence(input, { env, queryImpl, fetchImpl: reply(200, message) });
  assert.equal(ok.verdict, "verified");
  assert.equal(ok.announcements[0].author_is_linked_account, true);
  assert.equal(ok.announcements[0].posted_after_task_created, true);

  const someoneElse = await boardDiscordEvidence(input, { env, queryImpl, fetchImpl: reply(200, { ...message, author: { username: "another-member" } }) });
  assert.equal(someoneElse.verdict, "not_verified", "a message posted by a different Discord account is not proof");

  const old = await boardDiscordEvidence(input, { env, queryImpl, fetchImpl: reply(200, { ...message, timestamp: "2026-11-01T00:00:00.000Z" }) });
  assert.equal(old.verdict, "not_verified", "a message older than the task is not proof");

  const unlinked = await boardDiscordEvidence(input, { env, queryImpl: async () => ({ rows: [] }), fetchImpl: reply(200, message) });
  assert.equal(unlinked.verdict, "not_verified", "no linked Discord account means nothing to match");
});

test("a missing message is not verified; an unreadable one is unchecked, never a rejection", async () => {
  assert.equal((await boardDiscordEvidence(input, { env, queryImpl, fetchImpl: reply(404) })).verdict, "not_verified");
  const denied = await boardDiscordEvidence(input, { env, queryImpl, fetchImpl: reply(403) });
  assert.equal(denied.verdict, "unchecked");
  assert.equal(denied.announcements[0].status, "bot_cannot_read");
  assert.equal((await boardDiscordEvidence(input, { env: {}, queryImpl, fetchImpl: reply(200) })).state, "bot_not_configured");
  assert.equal((await boardDiscordEvidence({ ...input, payloads: [{ value: "no announcement" }] }, { env, queryImpl })).verdict, "none");
});
