import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocketServer } from "ws";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { query, closePool } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { createHiveGroupEvent, validateHiveGroupEvent, hiveMentions, mergeHiveGroupMessages } from "../shared/hive-group.js";
import { publishHiveEvent, fetchHiveRelayEvents } from "../server/hive-group-relay.js";
import { decideHiveGroupParticipation, composeHiveGroupReply, validateHiveGroupDecision } from "../server/hive-group-provider.js";
import { INFERENCE_MODELS } from "../server/inference.js";
import { ensureHiveGroupChannel, hiveGroupMembers, markHiveGroupDelivered, listHiveGroupMessages, claimHiveGroupBot, finishHiveGroupBot, listHiveGroupEscalations, hiveGroupUnread, markHiveGroupRead } from "../server/repositories/hive-group.js";
import { runHiveGroupWorkerOnce, runHiveGroupBotOnce } from "../server/hive-group-worker.js";
import { handleHiveGroupRoute } from "../server/hive-group-routes.js";
import { routeBodyPolicyForRequest, routePolicyForPath } from "../server/route-policies.js";
import { validateJsonDocument } from "../server/request-validation.js";
import { executeBoardAgentCommand } from "../server/board-agent-routes.js";
import { dispatchBoardAgent } from "../server/board-agent-dispatch.js";
import { computeBoardDuties } from "./bm/lib.mjs";
import { dutyId, openAgentRound, recordDutyResult } from "../server/board-agent-rounds.js";

assert.equal(new URL(process.env.DATABASE_URL).pathname, "/tasknode_hive_20260906", "Use only the disposable Hive fixture database");
process.env.TASKNODE_HIVE_NOSTR_SECRET_KEY = randomBytes(32).toString("hex");
const board = "board_pf_terminal", otherBoard = "board_capital_markets";
const waitDecision = { respond: false, escalate: false, board_id: "", source_event_id: "", escalation_summary: "", reply_brief: "" };
const wire = value => JSON.parse(JSON.stringify(value));
const relay = new WebSocketServer({ port: 0 });
await new Promise(resolve => relay.once("listening", resolve));
const relayUrl = `ws://127.0.0.1:${relay.address().port}`;
const received = new Map();
let rejectPublications = false;
relay.on("connection", socket => socket.on("message", raw => {
  const [type, item, filter] = JSON.parse(String(raw));
  if (type === "EVENT") {
    socket.send("null"); socket.send("{}"); // Malformed protocol frames must not crash delivery.
    if (!rejectPublications) received.set(item.id, item);
    socket.send(JSON.stringify(["OK", item.id, !rejectPublications, rejectPublications ? "blocked: fixture outage" : ""]));
  }
  if (type === "REQ") {
    socket.send("null"); socket.send("{}");
    for (const event of received.values()) if (event.kind === 1 && event.tags.some(tag => tag[0] === "e" && filter["#e"].includes(tag[1]))) socket.send(JSON.stringify(["EVENT", item, event]));
    socket.send(JSON.stringify(["EOSE", item]));
  }
}));
const members = ["elm", "lichen"].map(handle => { const key = randomBytes(32); return { handle, key, pubkey: getPublicKey(key), accountId: `hive_fixture_${handle}` }; });
let channel;
const event = (member, content, options = {}) => wire(createHiveGroupEvent({ privateKey: member.key, rootId: channel.root_event.id, relay: relayUrl, content, ...options }));
const reopenBot = () => query("UPDATE hive_group_channels SET bot_next_at=now(),bot_claim='',bot_lease_until=NULL");
async function route(accountId, method, path, body) {
  let response;
  const url = new URL(path, "https://fixture.invalid");
  const contract = routeBodyPolicyForRequest({ pathname: url.pathname, method });
  await handleHiveGroupRoute({ req: { method }, res: {}, url, session: accountId ? { accountId } : null,
    json: (_, status, body) => { response = { status, body }; }, readJson: async () => { if (contract) validateJsonDocument(body, contract.schema); return body; } });
  return response;
}
try {
  await migrateDatabase();
  await query("TRUNCATE hive_group_channels CASCADE");
  for (const table of ["app_accounts", "account_linked_wallets", "account_nostr_identities"]) await query(`DELETE FROM ${table} WHERE account_id=ANY($1::text[])`, [members.map(member => member.accountId)]);
  channel = await ensureHiveGroupChannel();
  await query("UPDATE hive_group_channels SET relays=$1::jsonb", [JSON.stringify([relayUrl])]);
  channel.relays = [relayUrl];
  for (const member of members) {
    const account = { id: member.accountId, status: "active", hiveHandle: member.handle, publicDisplayName: member.handle, profileVisibility: "public", profileDiscoverable: true, contextDocument: "PRIVATE_CONTEXT_CANARY" };
    await query("INSERT INTO app_accounts(account_id,account_json,hive_handle) VALUES($1,$2::jsonb,$3)", [member.accountId, JSON.stringify(account), member.handle]);
    await query("INSERT INTO account_linked_wallets(account_id,wallet_address) VALUES($1,$2)", [member.accountId, `rFixture${member.handle}`]);
    await query("INSERT INTO account_nostr_identities(account_id,nostr_pubkey_hex,npub,source_wallet_address,wallet_proof,visibility,expires_at) VALUES($1,$2,$3,$4,'{}'::jsonb,'public',now()+interval '1 day')",
      [member.accountId, member.pubkey, npubEncode(member.pubkey), `rFixture${member.handle}`]);
  }
  assert.equal((await hiveGroupMembers()).length, 3);
  assert.equal((await ensureHiveGroupChannel()).root_event.id, channel.root_event.id, "restarts keep the same public thread");
  await assert.rejects(ensureHiveGroupChannel({ TASKNODE_HIVE_NOSTR_SECRET_KEY: randomBytes(32).toString("hex") }), { message: "hive_group_bot_identity_changed" });
  await runHiveGroupWorkerOnce({ deps: { decide: async () => { throw new Error("No new member messages, so no model call"); } } });
  channel.published_at = new Date();
  assert.ok(received.has(channel.root_event.id)); assert.ok(received.has(channel.metadata_event.id));
  const replications = [];
  class DelayedRelaySocket extends EventEmitter {
    constructor(url) { super(); this.url=url; this.closed=false; setTimeout(() => { if (!this.closed) this.emit("open"); }, url === "fast" ? 1 : 40); }
    send(raw) { const event=JSON.parse(raw)[1]; replications.push(this.url); this.emit("message", JSON.stringify(["OK",event.id,true,""])); }
    close() { this.closed=true; this.emit("close"); }
  }
  assert.equal(await publishHiveEvent(channel.root_event,["fast","slow"],{WebSocketImpl:DelayedRelaySocket}),"fast");
  assert.deepEqual(replications,["fast"],"a slow relay must not delay send acknowledgement");
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.deepEqual(replications,["fast","slow"],"first ACK must not cancel replication to slower relays");
  assert.equal(routePolicyForPath("/api/hive/group/messages").auth, "session");
  assert.equal((await route("", "POST", "/api/hive/group/messages", {})).status, 401);
  const first = event(members[0], "Hello @lichen. An email user@lichen should not tag anyone.");
  assert.deepEqual(hiveMentions(first.content, members).map(item => item.member.handle), ["lichen"]);
  validateHiveGroupEvent(first, { rootId: channel.root_event.id, authorPubkey: members[0].pubkey });
  assert.throws(() => validateHiveGroupEvent({ ...first, sig: "0".repeat(128) }, { rootId: channel.root_event.id }));
  assert.throws(() => validateHiveGroupEvent(first, { rootId: "a".repeat(64) }));
  assert.throws(() => validateHiveGroupEvent(first, { rootId: channel.root_event.id, authorPubkey: members[1].pubkey }));
  assert.equal((await route(members[1].accountId, "POST", "/api/hive/group/messages", { event: first })).status, 400);
  const accepted = await route(members[0].accountId, "POST", "/api/hive/group/messages", { event: first });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.message.delivery, "delivered");
  const repeated = await route(members[0].accountId, "POST", "/api/hive/group/messages", { event: first });
  assert.equal(repeated.body.message.id, first.id);
  assert.equal((await query("SELECT count(*)::int n FROM hive_group_messages")).rows[0].n, 1);
  assert.equal((await fetchHiveRelayEvents({ rootId: channel.root_event.id, relays: [relayUrl] })).length, 1);
  assert.equal((await route(members[1].accountId, "GET", "/api/hive/group")).body.messages[0].id, first.id);
  assert.equal((await route("", "GET", "/api/hive/group")).body.messages[0].id, first.id, "public read does not require wallet unlock");
  assert.equal(await hiveGroupUnread(members[1].accountId), 1);
  await markHiveGroupRead(members[1].accountId, accepted.body.message.sequence);
  assert.equal(await hiveGroupUnread(members[1].accountId), 0);
  assert.equal((await query("SELECT count(*)::int n FROM hive_group_bot_runs")).rows[0].n, 0, "sending never invokes the model");

  const claims = await Promise.all(Array.from({ length: 10 }, () => claimHiveGroupBot()));
  assert.equal(claims.filter(Boolean).length, 1, "only one process may classify the batch");
  await finishHiveGroupBot({ claim: claims.find(Boolean), through: accepted.body.message.sequence, decision: waitDecision, decisionModel: "fixture-flash" });
  assert.equal(await claimHiveGroupBot(), null);
  rejectPublications = true;
  const pending = event(members[0], "This waits for relay delivery.");
  const queued = await route(members[0].accountId, "POST", "/api/hive/group/messages", { event: pending });
  assert.equal(queued.status, 202); assert.equal(queued.body.message.sequence, 0);
  assert.equal((await route(members[1].accountId, "GET", "/api/hive/group")).body.messages.some(row => row.id === pending.id), false);
  const second = event(members[1], "Please investigate the terminal task sync blocker before routing more work.");
  rejectPublications = false;
  const secondAccepted = await route(members[1].accountId, "POST", "/api/hive/group/messages", { event: second });
  await markHiveGroupDelivered(pending.id, await publishHiveEvent(pending, [relayUrl]));
  const late = (await query("SELECT * FROM hive_group_messages WHERE id=$1", [pending.id])).rows[0];
  assert.ok(Number(late.sequence) > secondAccepted.body.message.sequence, "late delivery gets a fresh sequence and cannot be skipped by the bot cursor");
  const outsiderKey = randomBytes(32);
  const outsider = event({ key: outsiderKey }, "Unregistered event must stay outside the room.");
  const forged = { ...first, id: "b".repeat(64) };
  received.set(outsider.id, outsider); received.set(forged.id, forged);
  let composed = 0, classified = 0;
  await reopenBot();
  const result = await runHiveGroupWorkerOnce({ deps: {
    decide: async ({ context }) => {
      classified++;
      assert.equal(JSON.stringify(context).includes("PRIVATE_CONTEXT_CANARY"), false);
      assert.equal(context.messages.some(item => item.id === outsider.id || item.id === forged.id), false);
      assert.ok(context.messages.find(item => item.id === pending.id)?.new);
      return { model: INFERENCE_MODELS.instantText, decision: validateHiveGroupDecision({ respond: true, escalate: true, board_id: board, source_event_id: second.id, escalation_summary: "Investigate a reported terminal task synchronization blocker.", reply_brief: "Acknowledge escalation without claiming a fix." }, context) };
    }, reply: async () => { composed++; return { text: "@lichen I’m passing the sync blocker to the Kimi board manager.", model: INFERENCE_MODELS.reasoningText }; },
  } });
  assert.equal(classified, 1); assert.equal(composed, 1); assert.equal(result.bot.escalated, true);
  assert.equal((await query("SELECT count(*)::int n FROM hive_group_messages WHERE id=ANY($1::text[])", [[outsider.id, forged.id]])).rows[0].n, 0);
  assert.equal((await runHiveGroupBotOnce({ channel, members: await hiveGroupMembers(), deps: { decide: async () => { throw new Error("Idle room must not classify again"); } } })).processed, false);
  const inbox = await listHiveGroupEscalations([board]); assert.equal(inbox.length, 1);
  const duties = (await computeBoardDuties([board], { idleContributors: async () => [] })).duties.filter(item => item.type === "hive_chat_escalation");
  assert.equal(duties.length, 1); assert.equal(duties[0].escalation_id, inbox[0].id);
  assert.notEqual(dutyId(duties[0]), dutyId({ ...duties[0], escalation_id: "another" }));
  const credential = randomUUID(), token = randomUUID();
  await query("INSERT INTO board_agent_credentials(id,token_hash,actor,board_ids,expires_at) VALUES($1,$2,$1,$3::jsonb,now()+interval '1 hour')", [credential, createHash("sha256").update(token).digest("hex"), JSON.stringify([board])]);
  const command = (argv, requestKey = randomUUID(), options) => executeBoardAgentCommand({ token, payload: { argv, requestKey } }, options);
  assert.equal((await command(["hive-inbox", board])).result.length, 1);
  await assert.rejects(command(["hive-inbox", otherBoard]), { status: 403 });
  const computeDuties = () => computeBoardDuties([board], { idleContributors: async () => [] }).then(result => ({ ...result, duties: result.duties.filter(item => item.type === "hive_chat_escalation") }));
  const round = (await command(["round-open", board], "round", { dispatch: () => openAgentRound([board], { computeDuties }) })).result;
  const dutyResult = { roundId: round.id, dutyId: round.duties_json[0].id, outcome: "completed", reason: "The inbox item should be closed by a durable public response." };
  await assert.rejects(command(["duty-result"], "false-completion", { dispatch: () => recordDutyResult(dutyResult, { computeDuties }) }), { status: 409 });
  const reply = ["hive-reply", inbox[0].id, "--message", "@lichen I checked the board. Please provide the task ID so the sync issue can be traced.", "--outcome", "resolved"];
  await assert.rejects(command(reply, "rollback", { dispatch: async argv => { await dispatchBoardAgent(argv); throw new Error("fixture_transaction_failure"); } }), { message: "fixture_transaction_failure" });
  assert.equal((await listHiveGroupEscalations([board])).length, 1, "failed command cannot close inbox or leak reply");
  const responses = await Promise.all(Array.from({ length: 5 }, () => command(reply, "reply-once")));
  assert.equal(responses.filter(row => !row.replayed).length, 1);
  assert.equal((await listHiveGroupEscalations([board])).length, 0);
  assert.equal((await query("SELECT count(*)::int n FROM hive_group_messages WHERE actor='board_manager'")).rows[0].n, 1);
  assert.equal((await command(["duty-result"], "complete", { dispatch: () => recordDutyResult(dutyResult, { computeDuties }) })).result.state, "complete");
  await runHiveGroupWorkerOnce();
  assert.ok(received.has(responses[0].result.responseEventId), "board reply reaches the same Nostr relay thread");

  const context = { boards: [{ id: board }], messages: [{ id: second.id, actor: "member", new: true, content: second.content }] };
  const decision = await decideHiveGroupParticipation({ context, env: { INFERENCE_MODEL_STRUCTURED: "wrong-model" }, complete: async input => {
    assert.equal(input.body.model, INFERENCE_MODELS.instantText); assert.equal(input.env.INFERENCE_MODEL_STRUCTURED, INFERENCE_MODELS.instantText);
    assert.equal(input.body.response_format.json_schema.strict, true); return { text: JSON.stringify(waitDecision), model: input.body.model };
  } });
  assert.equal(decision.decision.respond, false);
  await composeHiveGroupReply({ context, decision: waitDecision, env: { INFERENCE_MODEL_REASONING: "wrong-model" }, complete: async input => {
    assert.equal(input.body.model, INFERENCE_MODELS.reasoningText); assert.equal(input.env.INFERENCE_MODEL_REASONING, INFERENCE_MODELS.reasoningText);
    return { text: "A useful public contribution.", model: input.body.model };
  } });
  assert.throws(() => validateHiveGroupDecision({ ...waitDecision, respond: "false" }, context));
  assert.throws(() => validateHiveGroupDecision({ ...waitDecision, escalate: true, board_id: otherBoard, source_event_id: second.id, escalation_summary: "Unassigned board should be rejected." }, context));
  assert.throws(() => validateHiveGroupDecision({ ...waitDecision, respond: true, source_event_id: first.id }, context));
  const current = { id: first.id, event: first, sequence: 42, delivery: "delivered", actor: "board_manager", escalation: { state: "resolved" } };
  const merged = mergeHiveGroupMessages([current], [{ id: first.id, event: first, sequence: 0, delivery: "pending", actor: "board" }]);
  assert.equal(merged.length, 1); assert.equal(merged[0].delivery, "delivered"); assert.equal(merged[0].actor, "board_manager"); assert.equal(merged[0].sequence, 42);
  await query("UPDATE account_nostr_identities SET status='revoked' WHERE account_id=$1", [members[0].accountId]);
  assert.equal((await route(members[0].accountId, "POST", "/api/hive/group/messages", { event: event(members[0], "Revoked identity") })).status, 409);
  const outsideRoot = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now()/1000), tags: [], content: "Private legacy content is never imported" }, members[0].key);
  assert.equal((await listHiveGroupMessages()).some(row => row.id === outsideRoot.id), false);
  console.log(JSON.stringify({ ok: true, relay: "local WebSocket Nostr fixture", database: "isolated Postgres", checks: ["signed shared feed", "wrong account and signature rejected", "relay ACK and durable retry", "late delivery cursor", "ten concurrent bot claims", "public-only context", "idle bot silence", "Flash/GLM model contracts", "outsider and forged relay events ignored", "Kimi scoped inbox", "atomic rollback and five reply retries", "duty completion proof", "public reply relay delivery", "revoked identity rejected"] }));
} finally {
  await closePool();
  for (const socket of relay.clients) socket.terminate();
  await new Promise(resolve => relay.close(resolve));
}
