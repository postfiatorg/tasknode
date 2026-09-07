import WebSocket from "ws";
import { randomUUID } from "node:crypto";

// Relay ACKs, not local queue acceptance, establish delivery.
export async function publishHiveEvent(event, relays, { WebSocketImpl = WebSocket, timeoutMs = 8000 } = {}) {
  try {
    return await Promise.any(relays.map(url => new Promise((resolve, reject) => {
      const socket = new WebSocketImpl(url, { maxPayload: 128 * 1024, handshakeTimeout: timeoutMs });
      let settled = false;
      const finish = (accepted, reason) => {
        if (settled) return;
        settled = true; clearTimeout(timer); socket.close();
        if (accepted) resolve(url); else reject(new Error(reason));
      };
      const timer = setTimeout(() => finish(false,"hive_relay_timeout"), timeoutMs);
      const fail = () => finish(false,"hive_relay_unavailable");
      socket.on("error", fail); socket.on("close", fail);
      socket.on("open", () => socket.send(JSON.stringify(["EVENT", event])));
      socket.on("message", raw => {
        let value; try { value = JSON.parse(String(raw)); } catch { return; }
        if (!Array.isArray(value)) return;
        if (value[0] !== "OK" || value[1] !== event.id) return;
        finish(value[2] === true,"hive_relay_rejected");
      });
    })));
  } catch { throw Object.assign(new Error("hive_group_relay_unavailable"), { status: 503 }); }
  // Return the first positive ACK promptly. Each remaining relay completes its
  // own bounded attempt and cleans up its socket; do not cancel replication.
}

export async function fetchHiveRelayEvents({ rootId, relays, since = 0, limit = 200 }, { WebSocketImpl = WebSocket, timeoutMs = 6000 } = {}) {
  const outcomes = await Promise.allSettled(relays.map(url => new Promise((resolve) => {
    const events = [];
    const id = randomUUID();
    const socket = new WebSocketImpl(url, { maxPayload: 128 * 1024, handshakeTimeout: timeoutMs });
    const finish = () => { clearTimeout(timer); socket.close(); resolve(events); };
    const timer = setTimeout(finish, timeoutMs);
    socket.on("error", finish); socket.on("close", () => { clearTimeout(timer); resolve(events); });
    socket.on("open", () => socket.send(JSON.stringify(["REQ", id, { kinds: [1], "#e": [rootId], since, limit }])));
    socket.on("message", raw => {
      let value; try { value = JSON.parse(String(raw)); } catch { return; }
      if (!Array.isArray(value)) return;
      if (value[0] === "EVENT" && value[1] === id && events.length < limit) events.push({ event: value[2], relay: url });
      if (value[0] === "EOSE" && value[1] === id) finish();
    });
  })));
  return outcomes.flatMap(result => result.status === "fulfilled" ? result.value : []);
}
