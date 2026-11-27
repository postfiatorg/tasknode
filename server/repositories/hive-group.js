import { randomUUID } from "node:crypto";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { query, transactionCommand } from "../db/pool.js";
import { getNostrWellKnownDirectory, DEFAULT_NOSTR_RELAYS } from "./nostr-messages.js";
import {
  HIVE_GROUP_ID,
  HIVE_BOARD_HANDLE,
  HIVE_CHANNEL_KINDS,
  normalizeHiveChannelId,
  validateHiveGroupEvent,
} from "../../shared/hive-group.js";
import { isHexLength } from "../../shared/text-protocol.js";

export function hiveBotPrivateKey(env = process.env) {
  const key = String(env.TASKNODE_HIVE_NOSTR_SECRET_KEY || "").trim();
  if (!isHexLength(key, 64)) throw new Error("hive_group_bot_key_not_configured");
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(key.slice(index * 2, index * 2 + 2), 16));
}

export async function getHiveGroupChannel(channelId = HIVE_GROUP_ID) {
  const id = normalizeHiveChannelId(channelId);
  return (await query("SELECT * FROM hive_group_channels WHERE id=$1", [id])).rows[0] || null;
}

export async function listHiveGroupChannels({ includeArchived = false } = {}) {
  const sql = includeArchived
    ? "SELECT * FROM hive_group_channels ORDER BY (id = $1) DESC, created_at DESC"
    : "SELECT * FROM hive_group_channels WHERE COALESCE(status, 'active') <> 'archived' ORDER BY (id = $1) DESC, created_at DESC";
  return (await query(sql, [HIVE_GROUP_ID])).rows;
}

export async function createHiveGroupChannel({
  id,
  title = "",
  description = "",
  channelKind = HIVE_CHANNEL_KINDS.GOVERNANCE,
  sessionId = "",
  postingPolicy = "all_members",
  status = "scheduled",
  relays = DEFAULT_NOSTR_RELAYS,
  env = process.env,
} = {}) {
  const channelId = normalizeHiveChannelId(id);
  const key = hiveBotPrivateKey(env);
  const pubkey = getPublicKey(key);
  return transactionCommand(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [channelId]);
    const existing = await getHiveGroupChannel(channelId);
    if (existing) return existing;
    const created_at = Math.floor(Date.now() / 1000);
    const roomTitle = String(title || channelId).trim().slice(0, 200);
    const roomDescription = String(description || "Dedicated Post Fiat Hive channel.").trim().slice(0, 1000);
    const rootTags = [["t", "tasknode-hive"], ["d", channelId]];
    if (sessionId) rootTags.push(["t", `governance-${sessionId}`]);
    const root = finalizeEvent({
      kind: 1,
      created_at,
      tags: rootTags,
      content: `${roomTitle} — ${roomDescription}`,
    }, key);
    const metadata = finalizeEvent({
      kind: 0,
      created_at,
      tags: [],
      content: JSON.stringify({
        name: HIVE_BOARD_HANDLE,
        display_name: "Hive Board",
        about: "Task Node's automated community participant. Brings network questions to the board manager.",
        nip05: `${HIVE_BOARD_HANDLE}@${env.TASKNODE_NOSTR_NIP05_DOMAIN || "tasknode.postfiat.org"}`,
      }),
    }, key);
    const result = await query(
      `INSERT INTO hive_group_channels(
        id, root_event, bot_pubkey, metadata_event, relays,
        channel_kind, title, description, session_id, posting_policy, status
      ) VALUES($1, $2::jsonb, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        channelId,
        JSON.stringify(root),
        pubkey,
        JSON.stringify(metadata),
        JSON.stringify(Array.isArray(relays) && relays.length ? relays : DEFAULT_NOSTR_RELAYS),
        channelKind === HIVE_CHANNEL_KINDS.GOVERNANCE ? HIVE_CHANNEL_KINDS.GOVERNANCE : HIVE_CHANNEL_KINDS.GENERAL,
        roomTitle,
        roomDescription,
        String(sessionId || "").trim().slice(0, 120),
        ["founder_only", "allowlist", "all_members"].includes(postingPolicy) ? postingPolicy : "all_members",
        ["scheduled", "active", "closed", "archived"].includes(status) ? status : "scheduled",
      ]
    );
    return result.rows[0];
  });
}

export async function updateHiveGroupChannelStatus(channelId, { status, openedAt = null, closedAt = null } = {}) {
  const id = normalizeHiveChannelId(channelId);
  const result = await query(
    `UPDATE hive_group_channels
     SET status = COALESCE($2, status),
         opened_at = COALESCE($3, opened_at),
         closed_at = COALESCE($4, closed_at)
     WHERE id = $1
     RETURNING *`,
    [id, status || null, openedAt, closedAt]
  );
  return result.rows[0] || null;
}

export async function ensureHiveGroupChannel(env = process.env) {
  const key = hiveBotPrivateKey(env);
  const pubkey = getPublicKey(key);
  return transactionCommand(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [HIVE_GROUP_ID]);
    const existing = await getHiveGroupChannel(HIVE_GROUP_ID);
    if (existing) {
      if (existing.bot_pubkey !== pubkey) throw new Error("hive_group_bot_identity_changed");
      return existing;
    }
    const collision = await query("SELECT 1 FROM app_accounts WHERE lower(hive_handle)=$1 LIMIT 1", [HIVE_BOARD_HANDLE]);
    if (collision.rowCount) throw new Error("hive_group_bot_handle_already_owned");
    const created_at = Math.floor(Date.now() / 1000);
    const root = finalizeEvent({ kind: 1, created_at, tags: [["t", "tasknode-hive"]], content: "Hive — the public Task Node group chat. Use your Task Node Messages identity to join the conversation." }, key);
    const metadata = finalizeEvent({ kind: 0, created_at, tags: [], content: JSON.stringify({ name: HIVE_BOARD_HANDLE, display_name: "Hive Board", about: "Task Node's automated community participant. Brings network questions to the board manager.", nip05: `${HIVE_BOARD_HANDLE}@${env.TASKNODE_NOSTR_NIP05_DOMAIN || "tasknode.postfiat.org"}` }) }, key);
    const result = await query(`INSERT INTO hive_group_channels(id,root_event,bot_pubkey,metadata_event,relays)
      VALUES($1,$2::jsonb,$3,$4::jsonb,$5::jsonb) RETURNING *`, [HIVE_GROUP_ID,JSON.stringify(root),pubkey,JSON.stringify(metadata),JSON.stringify(DEFAULT_NOSTR_RELAYS)]);
    return result.rows[0];
  });
}

export async function hiveGroupMembers() {
  const directory = await getNostrWellKnownDirectory();
  return Object.entries(directory.names).map(([handle,pubkey]) => ({
    pubkey, handle, nip05: `${handle}@${process.env.TASKNODE_NOSTR_NIP05_DOMAIN || "tasknode.postfiat.org"}`,
    ...(directory.profiles[pubkey] || {}),
  }));
}

export function publicHiveGroupChannel(channel) {
  if (!channel) return null;
  return {
    id: channel.id,
    channelKind: channel.channel_kind || HIVE_CHANNEL_KINDS.GENERAL,
    title: channel.title || (channel.id === HIVE_GROUP_ID ? "Hive chat" : channel.id),
    description: channel.description || "",
    sessionId: channel.session_id || "",
    postingPolicy: channel.posting_policy || "all_members",
    status: channel.status || "active",
    openedAt: channel.opened_at || null,
    closedAt: channel.closed_at || null,
    rootEvent: channel.root_event,
    relays: channel.relays,
    botPubkey: channel.bot_pubkey,
    ready: Boolean(channel.published_at),
  };
}

export function publicHiveGroupMessage(row, members = []) {
  return { id: row.id, channelId: row.channel_id || HIVE_GROUP_ID, sequence: Number(row.sequence || 0), event: row.event_json,
    author: members.find(member => member.pubkey === row.author_pubkey) || row.author_json,
    actor: row.actor, delivery: row.delivery_state, escalation: row.escalation || null };
}

export async function recordHiveGroupEvent({ event, channel, member, relay = "", actor = "member" }) {
  validateHiveGroupEvent(event, { rootId: channel.root_event.id, authorPubkey: member.pubkey });
  const result = await query(`INSERT INTO hive_group_messages(id,channel_id,account_id,author_pubkey,author_json,event_json,actor,delivery_state,relay_url,delivered_at,sequence)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,CASE WHEN $8='delivered' THEN now() ELSE NULL END,CASE WHEN $8='delivered' THEN nextval('hive_group_message_sequence') ELSE NULL END)
    ON CONFLICT(id) DO UPDATE SET delivery_state=CASE WHEN EXCLUDED.delivery_state='delivered' THEN 'delivered' ELSE hive_group_messages.delivery_state END,
      sequence=COALESCE(hive_group_messages.sequence,EXCLUDED.sequence),delivered_at=COALESCE(hive_group_messages.delivered_at,EXCLUDED.delivered_at),
      relay_url=CASE WHEN EXCLUDED.relay_url<>'' THEN EXCLUDED.relay_url ELSE hive_group_messages.relay_url END RETURNING *`,
  [event.id,channel.id,member.accountId || "",event.pubkey,JSON.stringify(member),JSON.stringify(event),actor,relay ? "delivered" : "pending",relay]);
  return result.rows[0];
}

export async function markHiveGroupDelivered(id, relay) {
  return (await query(`UPDATE hive_group_messages SET delivery_state='delivered',relay_url=$2,delivered_at=COALESCE(delivered_at,now()),
    sequence=COALESCE(sequence,nextval('hive_group_message_sequence')) WHERE id=$1 RETURNING *`, [id,relay])).rows[0];
}

export async function listHiveGroupMessages({ channelId = HIVE_GROUP_ID, accountId = "", limit = 120, through = Number.MAX_SAFE_INTEGER } = {}) {
  const id = normalizeHiveChannelId(channelId);
  const result = await query(`SELECT message.*, (SELECT jsonb_build_object('id',e.id,'boardId',e.board_id,'state',e.state,'responseEventId',e.response_event_id)
    FROM hive_group_escalations e WHERE e.source_event_id=message.id ORDER BY e.created_at DESC LIMIT 1) AS escalation
    FROM hive_group_messages message WHERE channel_id=$1 AND (delivery_state='delivered' OR (account_id=$2 AND $2<>''))
    AND (sequence IS NULL OR sequence<=$4) ORDER BY sequence DESC NULLS FIRST,created_at DESC,id DESC LIMIT $3`, [id,accountId,Math.max(1,Math.min(500,Number(limit)||120)),through]);
  return result.rows.reverse();
}

export async function hiveGroupUnread(accountId, channelId = HIVE_GROUP_ID) {
  if (!accountId) return 0;
  const id = normalizeHiveChannelId(channelId);
  if (id === HIVE_GROUP_ID) {
    const result = await query(`SELECT count(*)::int AS count FROM hive_group_messages WHERE channel_id=$1 AND delivery_state='delivered'
      AND account_id<>$2 AND sequence>COALESCE((SELECT last_sequence FROM hive_group_reads WHERE account_id=$2),0)`, [id,accountId]);
    return result.rows[0].count;
  }
  const result = await query(`SELECT count(*)::int AS count FROM hive_group_messages WHERE channel_id=$1 AND delivery_state='delivered'
    AND account_id<>$2 AND sequence>COALESCE((SELECT last_sequence FROM hive_group_channel_reads WHERE account_id=$2 AND channel_id=$1),0)`, [id,accountId]);
  return result.rows[0].count;
}

export async function markHiveGroupRead(accountId, sequence, channelId = HIVE_GROUP_ID) {
  const id = normalizeHiveChannelId(channelId);
  if (id === HIVE_GROUP_ID) {
    await query(`INSERT INTO hive_group_reads(account_id,last_sequence) VALUES($1,LEAST($2::bigint,COALESCE((SELECT max(sequence) FROM hive_group_messages WHERE channel_id=$3),0)))
      ON CONFLICT(account_id) DO UPDATE SET last_sequence=GREATEST(hive_group_reads.last_sequence,EXCLUDED.last_sequence),updated_at=now()`, [accountId,sequence,id]);
    return;
  }
  await query(`INSERT INTO hive_group_channel_reads(account_id,channel_id,last_sequence) VALUES($1,$3,LEAST($2::bigint,COALESCE((SELECT max(sequence) FROM hive_group_messages WHERE channel_id=$3),0)))
    ON CONFLICT(account_id,channel_id) DO UPDATE SET last_sequence=GREATEST(hive_group_channel_reads.last_sequence,EXCLUDED.last_sequence),updated_at=now()`, [accountId,sequence,id]);
}

export async function claimHiveGroupBot({ channelId = HIVE_GROUP_ID, intervalSeconds = 60 } = {}) {
  const id = normalizeHiveChannelId(channelId);
  const result = await query(`UPDATE hive_group_channels SET bot_claim=$2,bot_lease_until=now()+interval '6 minutes',bot_next_at=now()+($3 * interval '1 second')
    WHERE id=$1 AND bot_next_at<=now() AND (bot_lease_until IS NULL OR bot_lease_until<now())
    AND EXISTS(SELECT 1 FROM hive_group_messages WHERE channel_id=$1 AND actor='member' AND delivery_state='delivered' AND sequence>bot_cursor)
    RETURNING *`, [id,randomUUID(),Math.max(30,intervalSeconds)]);
  return result.rows[0] || null;
}

export async function finishHiveGroupBot({ claim, through, decision, decisionModel, replyModel = "", event = null, member }) {
  return transactionCommand(async () => {
    const owned = await query("SELECT id FROM hive_group_channels WHERE id=$1 AND bot_claim=$2 AND bot_lease_until>now() FOR UPDATE", [claim.id,claim.bot_claim]);
    if (!owned.rowCount) throw new Error("hive_group_bot_lease_lost");
    const id = `hive_bot_${claim.id}_${through}`;
    if (decision.escalate) await query(`INSERT INTO hive_group_escalations(id,channel_id,board_id,source_event_id,summary)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(board_id,source_event_id) DO NOTHING`, [`hive_escalation_${randomUUID()}`,claim.id,decision.board_id,decision.source_event_id,decision.escalation_summary]);
    if (event) await recordHiveGroupEvent({ event,channel:claim,member,actor:"board" });
    await query(`INSERT INTO hive_group_bot_runs(id,channel_id,through_sequence,decision_json,reply_event_id,decision_model,reply_model)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) ON CONFLICT(channel_id,through_sequence) DO NOTHING`, [id,claim.id,through,JSON.stringify(decision),event?.id || "",decisionModel,replyModel]);
    await query("UPDATE hive_group_channels SET bot_cursor=$3,bot_claim='',bot_lease_until=NULL WHERE id=$1 AND bot_claim=$2", [claim.id,claim.bot_claim,through]);
    return { id, replyEventId: event?.id || "", escalated: decision.escalate };
  });
}

export async function listHiveGroupEscalations(boardIds, { queryImpl = query } = {}) {
  return (await queryImpl(`SELECT escalation.*,message.event_json AS source_event,message.author_json AS source_author FROM hive_group_escalations escalation
    JOIN hive_group_messages message ON message.id=escalation.source_event_id
    WHERE escalation.board_id=ANY($1::text[]) AND escalation.state='pending' ORDER BY escalation.created_at LIMIT 40`, [boardIds])).rows;
}
