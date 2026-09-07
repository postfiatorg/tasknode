import { query, databaseEnabled } from "./db/pool.js";
import { inferenceConfigured } from "./inference.js";
import { DETERMINISTIC_BOARD_IDS } from "./board-config.js";
import { createHiveGroupEvent, hiveMentions } from "../shared/hive-group.js";
import { ensureHiveGroupChannel, hiveBotPrivateKey, hiveGroupMembers, recordHiveGroupEvent, markHiveGroupDelivered,
  claimHiveGroupBot, finishHiveGroupBot, listHiveGroupMessages, listHiveGroupEscalations } from "./repositories/hive-group.js";
import { publishHiveEvent, fetchHiveRelayEvents } from "./hive-group-relay.js";
import { decideHiveGroupParticipation, composeHiveGroupReply } from "./hive-group-provider.js";

let timer;
let running = false;
let botRunning = null;

export async function deliverHiveGroupMessage(row, channel, { publish = publishHiveEvent } = {}) {
  try {
    const relay = await publish(row.event_json, channel.relays);
    return await markHiveGroupDelivered(row.id, relay);
  } catch {
    await query(`UPDATE hive_group_messages SET publish_attempts=publish_attempts+1,next_publish_at=now()+interval '15 seconds'
      WHERE id=$1 AND delivery_state='pending'`, [row.id]);
    return row;
  }
}

export async function runHiveGroupBotOnce({ channel, members, env = process.env, deps = {} }) {
  const claim = await claimHiveGroupBot({ intervalSeconds: Number(env.TASKNODE_HIVE_GROUP_BOT_INTERVAL_SECONDS || 60) });
  if (!claim) return { processed: false };
  try {
    // Process bounded batches in delivery order, including late outbox retries.
    const next = await query("SELECT sequence FROM hive_group_messages WHERE channel_id=$1 AND actor='member' AND delivery_state='delivered' AND sequence>$2 ORDER BY sequence LIMIT 40", [channel.id,claim.bot_cursor]);
    const through = Number(next.rows.at(-1)?.sequence || claim.bot_cursor);
    const [rows, boards, escalations] = await Promise.all([
      listHiveGroupMessages({ through, limit: 60 }),
      query("SELECT id,title,summary,status FROM network_projects WHERE id=ANY($1::text[]) AND status NOT IN ('archived','completed','cancelled','rejected')", [DETERMINISTIC_BOARD_IDS]),
      listHiveGroupEscalations(DETERMINISTIC_BOARD_IDS),
    ]);
    const context = { visibility: "public", room: { name:"Hive chat", bot_handle:"hive-board", root_event_id:channel.root_event.id,
      identity:"Existing public Task Node Messages Nostr identity and NIP-05 handle; profile pictures come from public profiles.",
      sending:"Sign in, activate Messages, then unlock the linked wallet to sign public kind-1 thread messages. Reading does not require wallet unlock.",
      privacy:"Hive is public on Nostr. Direct Messages use a separate encrypted NIP-17 inbox. Private chat, task evidence and memory are not included here.",
      board_handoff:"A durable escalation enters the existing Kimi K3 terminal board manager inbox. Only the board manager's normal scoped commands can change tasks or rewards.",
    }, boards: boards.rows,
      pending_escalations: escalations.map(item => ({ id:item.id,board_id:item.board_id,source_event_id:item.source_event_id,summary:item.summary })),
      messages: rows.map(row => ({ id:row.id,actor:row.actor,handle:members.find(member=>member.pubkey===row.author_pubkey)?.handle || row.author_json.handle,
        content:row.event_json.content.slice(0,4000),new:Number(row.sequence)>Number(claim.bot_cursor),created_at:row.event_json.created_at })),
    };
    const classified = await (deps.decide || decideHiveGroupParticipation)({ context,env });
    const decision = classified.decision;
    let event = null, replyModel = "";
    const member = members.find(member => member.pubkey === channel.bot_pubkey);
    if (decision.respond) {
      const response = await (deps.reply || composeHiveGroupReply)({ context,decision,env });
      replyModel = response.model;
      event = createHiveGroupEvent({ privateKey:hiveBotPrivateKey(env),rootId:channel.root_event.id,relay:channel.relays[0],content:response.text,
        replyTo:decision.source_event_id,mentions:hiveMentions(response.text,members).map(mention=>mention.member.pubkey) });
    }
    const result = await finishHiveGroupBot({ claim,through,decision,decisionModel:classified.model,replyModel,event,member });
    return { processed:true,...result };
  } catch (error) {
    await query("UPDATE hive_group_channels SET bot_claim='',bot_lease_until=NULL WHERE id=$1 AND bot_claim=$2", [claim.id,claim.bot_claim]);
    throw error;
  }
}

export async function runHiveGroupWorkerOnce({ env = process.env, deps = {}, waitForBot = true } = {}) {
  const channel = await ensureHiveGroupChannel(env);
  const publish = deps.publish || publishHiveEvent;
  if (!channel.published_at) {
    await publish(channel.root_event,channel.relays);
    await publish(channel.metadata_event,channel.relays);
    await query("UPDATE hive_group_channels SET published_at=now() WHERE id=$1", [channel.id]);
  }
  const members = await hiveGroupMembers();
  const pending = await query("SELECT * FROM hive_group_messages WHERE channel_id=$1 AND delivery_state='pending' AND next_publish_at<=now() ORDER BY created_at LIMIT 20", [channel.id]);
  await Promise.all(pending.rows.map(row=>deliverHiveGroupMessage(row,channel,{publish})));
  const recent = Number((await query("SELECT COALESCE(max((event_json->>'created_at')::bigint),0) AS latest FROM hive_group_messages WHERE channel_id=$1 AND delivery_state='delivered'",[channel.id])).rows[0].latest);
  const received = await (deps.fetchEvents || fetchHiveRelayEvents)({ rootId:channel.root_event.id,relays:channel.relays,since:Math.max(channel.root_event.created_at,recent-600) });
  for (const { event,relay } of received) {
    const member = members.find(member=>member.pubkey===event?.pubkey);
    if (!member) continue;
    try { await recordHiveGroupEvent({ event,channel,member,relay,actor:member.bot ? "board" : "member" }); }
    catch (error) { if (!error.status) throw error; }
  }
  let bot = { processed:false };
  if (inferenceConfigured(env) || deps.decide) {
    if (waitForBot) bot = await runHiveGroupBotOnce({channel,members,env,deps});
    else if (!botRunning) {
      botRunning = runHiveGroupBotOnce({channel,members,env,deps})
        .catch(() => console.error("hive_group_bot_failed", { code:"participation_failed" }))
        .finally(() => { botRunning = null; });
    }
  }
  return { ok:true,imported:received.length,bot };
}

export function startHiveGroupWorker() {
  if (timer || !databaseEnabled() || process.env.TASKNODE_HIVE_GROUP_ENABLED !== "true" || !process.env.TASKNODE_HIVE_NOSTR_SECRET_KEY) return { skipped:true };
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runHiveGroupWorkerOnce({waitForBot:false}); }
    catch (error) { console.error("hive_group_worker_failed", {code:error.status || "worker_error"}); }
    finally { running = false; }
  };
  timer = setInterval(tick,5000); timer.unref?.(); void tick();
  return { started:true,intervalMs:5000 };
}
