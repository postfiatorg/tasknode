import { getNostrMessagingBootstrap } from "./repositories/nostr-messages.js";
import { getHiveGroupChannel,hiveGroupMembers,listHiveGroupMessages,publicHiveGroupMessage,recordHiveGroupEvent,hiveGroupUnread,markHiveGroupRead } from "./repositories/hive-group.js";
import { validateHiveGroupEvent } from "../shared/hive-group.js";
import { deliverHiveGroupMessage } from "./hive-group-worker.js";

export async function handleHiveGroupRoute({ req,res,url,session,json,readJson }) {
  if (!url.pathname.startsWith("/api/hive/group")) return false;
  try {
    const channel = await getHiveGroupChannel();
    const accountId = session?.accountId || "";
    if (url.pathname === "/api/hive/group/status" && req.method === "GET") {
      const [messaging,unreadCount] = await Promise.all([accountId ? getNostrMessagingBootstrap({accountId}) : null,hiveGroupUnread(accountId)]);
      json(res,200,{ok:true,ready:Boolean(channel?.published_at),messaging,unreadCount}); return true;
    }
    if (url.pathname === "/api/hive/group" && req.method === "GET") {
      const [members,rows,messaging,unreadCount] = await Promise.all([
        hiveGroupMembers(),listHiveGroupMessages({accountId}),accountId ? getNostrMessagingBootstrap({accountId}) : null,hiveGroupUnread(accountId),
      ]);
      json(res,200,{ok:true,channel:channel ? {id:channel.id,rootEvent:channel.root_event,relays:channel.relays,botPubkey:channel.bot_pubkey,ready:Boolean(channel.published_at)} : null,
        members,messages:rows.map(row=>publicHiveGroupMessage(row,members)),messaging,unreadCount});
      return true;
    }
    if (!accountId) { json(res,401,{ok:false,error:"hive_group_login_required",message:"Sign in to join Hive."}); return true; }
    if (url.pathname === "/api/hive/group/read" && req.method === "POST") {
      const payload = await readJson(req,4096);
      await markHiveGroupRead(accountId,payload.sequence);
      json(res,200,{ok:true}); return true;
    }
    if (url.pathname !== "/api/hive/group/messages" || req.method !== "POST") { json(res,405,{ok:false,error:"method_not_allowed"}); return true; }
    if (!channel?.published_at) { json(res,503,{ok:false,error:"hive_group_starting",message:"Hive chat is connecting. Please try again shortly."}); return true; }
    const [payload,members] = await Promise.all([readJson(req,64*1024),hiveGroupMembers()]);
    const member = members.find(member=>member.accountId===accountId && !member.bot);
    if (!member) { json(res,409,{ok:false,error:"hive_group_messages_setup_required",message:"Activate your messaging identity in Messages to join Hive."}); return true; }
    validateHiveGroupEvent(payload.event,{rootId:channel.root_event.id,authorPubkey:member.pubkey});
    const stored = await recordHiveGroupEvent({event:payload.event,channel,member});
    const row = stored.delivery_state === "delivered" ? stored : await deliverHiveGroupMessage(stored,channel);
    json(res,row.delivery_state === "delivered" ? 200 : 202,{ok:true,message:publicHiveGroupMessage(row,members)});
  } catch (error) {
    json(res,Number(error.status)||500,{ok:false,error:error.status ? error.message : "hive_group_unavailable",message:error.status ? "The signed message could not be accepted. Your draft is still available." : "Hive chat is temporarily unavailable. Please try again."});
  }
  return true;
}
