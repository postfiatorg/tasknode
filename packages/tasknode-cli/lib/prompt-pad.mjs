import Crypto from "chainpad-crypto";
import ChainPad from "chainpad";
import CPNF from "chainpad-netflux";
import Netflux from "netflux-websocket";
import WebSocket from "ws";
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (test()) return;
    await delay(100);
  }
  throw new Error("Prompt pad synchronization timed out");
}
export function newPromptCapability(origin) {
  const keys = Crypto.createEditCryptor2();
  return {
    channelHash: Buffer.from(Crypto.b64AddSlashes(keys.chanId), "base64").toString("hex"),
    editHref: `/code/#/2/code/edit/${Crypto.b64RemoveSlashes(keys.editKeyStr)}/`,
    viewHref: `/code/#/2/code/view/${Crypto.b64RemoveSlashes(keys.viewKeyStr)}/`,
    origin,
  };
}
export function promptPadSecrets(origin, editHref) {
  const url = new URL(editHref, origin);
  if (url.origin !== new URL(origin).origin || url.pathname !== "/code/") throw new Error("Invalid prompt origin");
  const match = /^#\/2\/code\/edit\/([A-Za-z0-9+_-]{24})\/$/.exec(url.hash);
  if (!match) throw new Error("Unsupported prompt capability (requires an unpassworded v2 markdown edit link)");
  const keys = Crypto.createEditCryptor2(Crypto.b64AddSlashes(match[1]));
  const channel = Buffer.from(Crypto.b64AddSlashes(keys.chanId), "base64").toString("hex");
  return { keys, channel };
}
export async function joinPromptPad(origin, editHref) {
  const { keys, channel } = promptPadSecrets(origin, editHref);
  const network = await Netflux.connect(
    origin.replace(/^http/, "ws") + "/cryptpad_websocket",
    (address) => new WebSocket(address),
  );
  let session;
  let rt;
  try {
    rt = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Prompt pad join timed out")), 30000);
      session = CPNF.start({
        network,
        channel,
        validateKey: keys.validateKey,
        crypto: Crypto.createEncryptor(keys),
        ChainPad,
        initialState: "",
        avgSyncMilliseconds: 100,
        logLevel: 0,
        patchTransformer: ChainPad.SmartJSONTransformer,
        validateContent: (value) => {
          try {
            return typeof JSON.parse(value) === "object";
          } catch {
            return false;
          }
        },
        onReady: (data) => {
          clearTimeout(timer);
          resolve(data.realtime);
        },
        onError: () => {
          clearTimeout(timer);
          reject(new Error("Prompt pad channel failed"));
        },
      });
    });
  } catch (error) {
    session?.stop?.();
    network.disconnect();
    throw error;
  }
  return {
    channel,
    read() {
      const raw = rt.getUserDoc();
      return raw ? JSON.parse(raw) : null;
    },
    async write(doc, expectedRaw) {
      if (expectedRaw !== undefined && rt.getUserDoc() !== expectedRaw)
        throw new Error("Prompt changed concurrently; read and retry");
      const value = JSON.stringify(canonical(doc));
      rt.contentUpdate(value);
      await until(() => rt.getAuthDoc() === rt.getUserDoc());
      if (JSON.parse(rt.getUserDoc()).content !== doc.content)
        throw new Error("Prompt changed concurrently; read before retrying");
    },
    raw() {
      return rt.getUserDoc();
    },
    close() {
      rt.abort();
      session.stop?.();
      network.disconnect();
    },
  };
}
