import { query, transactionCommand } from "./db/pool.js";
import { assertBoardAgentScope, boardAgentActor } from "./board-agent-context.js";
import { getHiveGroupChannel, hiveBotPrivateKey, hiveGroupMembers, recordHiveGroupEvent } from "./repositories/hive-group.js";
import { createHiveGroupEvent, hiveMentions } from "../shared/hive-group.js";

// A board reply is committed to the same durable outbox as community messages.
// No relay or model call happens inside the scoped command transaction.
export async function replyToHiveEscalation({ id, message, outcome, env = process.env }) {
  if (typeof message !== "string" || !message.trim() || message.length > 4000 || !["resolved", "declined"].includes(outcome)) {
    throw Object.assign(new Error("hive_board_reply_invalid"), { status: 400 });
  }
  return transactionCommand(async () => {
    const row = (await query("SELECT * FROM hive_group_escalations WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!row) throw Object.assign(new Error("hive_escalation_not_found"), { status: 404 });
    assertBoardAgentScope(row.board_id);
    if (row.state !== "pending") return { id, state: row.state, responseEventId: row.response_event_id, replayed: true };
    const channel = await getHiveGroupChannel();
    if (!channel?.published_at) throw Object.assign(new Error("hive_group_starting"), { status: 503 });
    const members = await hiveGroupMembers();
    const event = createHiveGroupEvent({ privateKey: hiveBotPrivateKey(env), rootId: channel.root_event.id,
      relay: channel.relays[0], replyTo: row.source_event_id, content: message,
      mentions: hiveMentions(message, members).map(item => item.member.pubkey) });
    await recordHiveGroupEvent({ event, channel, member: members.find(item => item.pubkey === channel.bot_pubkey), actor: "board_manager" });
    await query("UPDATE hive_group_escalations SET state=$2,response_event_id=$3,resolved_by=$4,resolved_at=now() WHERE id=$1",
      [id, outcome, event.id, boardAgentActor()]);
    return { id, state: outcome, responseEventId: event.id, delivery: "pending" };
  });
}
