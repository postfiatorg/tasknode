import {createHmac,timingSafeEqual} from "node:crypto";

// Reuse the X application's registered Task Node callback. Corbanu owns the
// PKCE verifier and browser state; this route never creates a Task Node session.
export function corbanuXCallback(query={},secret=process.env.CORBANU_TASKNODE_INTEGRATION_SECRET,now=Date.now()) {
  const state=query.state;
  if(typeof state!=="string"||!state.startsWith("cbn1."))return null;
  const invalid={status:400,body:{ok:false,error:"corbanu_x_state_invalid"}};
  const parts=state.split(".");
  if(!secret||state.length>512||parts.length!==5)return invalid;
  const expiry=Number(parts[3]);
  if(!Number.isSafeInteger(expiry)||expiry<=now||expiry>now+600000)return invalid;
  const expected=createHmac("sha256",secret).update(parts.slice(0,4).join(".")).digest("base64url");
  if(expected.length!==parts[4].length||!timingSafeEqual(Buffer.from(expected),Buffer.from(parts[4])))return invalid;
  const url=new URL("https://api.corbanu.com/v2/indexes/x/callback");url.searchParams.set("state",state);
  if(typeof query.error==="string")url.searchParams.set("error","access_denied");
  else if(typeof query.code==="string"&&query.code.length>0&&query.code.length<=4096)url.searchParams.set("code",query.code);
  else return invalid;
  return {status:302,redirectLocation:url.toString(),body:{ok:true,provider:"x",action:"corbanu_index_claim"}};
}
