import { encryptPrompt, decryptPrompt } from "./prompt-crypto.mjs";
import { unwrapPromptDevice } from "./prompt-device.mjs";
import { promptStats } from "./prompt-stats.mjs";
import { joinPromptPad, newPromptCapability } from "./prompt-pad.mjs";

export class PromptClient {
  constructor(device) {
    this.device = device;
  }
  async request(path, body) {
    const response = await fetch(`${this.device.origin}/api/docs/prompts/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.device.token}`,
        "x-prompt-device": this.device.deviceId,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`Prompt service rejected request (${response.status}); check device approval and connection`);
    return response.json();
  }
  async key() {
    return unwrapPromptDevice((await this.request("device-key")).envelope, this.device);
  }
  async documents(key) {
    const { documents } = await this.request("documents");
    return Promise.all(
      documents.map(async (row) => {
        const metadata = await decryptPrompt(row.encryptedMetadata, key);
        if (metadata.documentId !== row.documentId) throw new Error("Prompt metadata identity mismatch");
        return { ...row, metadata };
      }),
    );
  }
  async document(id, key) {
    const doc = (await this.documents(key)).find((row) => row.documentId === id);
    if (!doc || doc.metadata.documentType !== "prompt") throw new Error("Prompt not found");
    return doc;
  }
  async event(documentId, payload, key) {
    const eventId = crypto.randomUUID();
    const event = { ...payload, eventId, documentId, at: new Date().toISOString() };
    await this.request("history", { eventId, documentId, ciphertext: await encryptPrompt(event, key) });
    return event;
  }
  async history(key) {
    const events = [];
    let after = "";
    do {
      const result = await this.request(`history${after ? `?after=${after}` : ""}`);
      for (const row of result.events) {
        const event = await decryptPrompt(row.ciphertext, key);
        if (event.eventId !== row.eventId || event.documentId !== row.documentId)
          throw new Error("Prompt history identity mismatch");
        events.push({ ...event, createdAt: row.createdAt });
      }
      after = result.next;
    } while (after);
    return events;
  }
  async call(name, args = {}) {
    const key = await this.key(); // Check approval/revocation on every tool call.
    if (name === "prompt_list") {
      const history = await this.history(key);
      return (await this.documents(key)).map((doc) => ({
        documentId: doc.documentId,
        title: doc.metadata.title,
        updatedAt: doc.updatedAt,
        savedVersions: history.filter((event) => event.documentId === doc.documentId && event.kind === "version_saved")
          .length,
      }));
    }
    if (name === "prompt_history")
      return (await this.history(key)).filter((event) => !args.documentId || event.documentId === args.documentId);
    if (name === "prompt_stats") return promptStats(await this.history(key), { days: args.days || 7 });
    if (name === "prompt_log_tih_run") {
      await this.document(args.documentId, key);
      if (!Number.isFinite(args.before) || !Number.isFinite(args.after))
        throw new Error("TIH scores must be finite numbers");
      return this.event(args.documentId, { kind: "tih_run", before: args.before, after: args.after }, key);
    }
    const { pfdocsOrigin: origin } = await this.request("config");
    if (!origin) throw new Error("PFDocs is not configured");
    const url = new URL(origin);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw new Error("PFDocs requires HTTPS outside localhost");
    if (name === "prompt_create") {
      if (
        typeof args.name !== "string" ||
        !args.name.trim() ||
        args.name.length > 140 ||
        (args.text !== undefined && typeof args.text !== "string")
      )
        throw new Error("Provide a prompt name and optional text");
      const documentId = crypto.randomUUID();
      const cap = newPromptCapability(origin);
      const title = `${args.name.trim()} — ${new Date().toISOString().slice(0, 10)}`;
      const metadata = {
        documentId,
        title,
        documentType: "prompt",
        editHref: cap.editHref,
        viewHref: cap.viewHref,
        createdAt: new Date().toISOString(),
      };
      const pad = await joinPromptPad(origin, cap.editHref);
      try {
        await pad.write({
          content: args.text || "",
          highlightMode: "gfm",
          metadata: { type: "code", title, users: {} },
        });
      } finally {
        pad.close();
      }
      const created = { eventId: crypto.randomUUID(), documentId, kind: "created", by: "agent", at: new Date().toISOString() };
      await this.request("documents", {
        documentId,
        channelHash: cap.channelHash,
        encryptedMetadata: await encryptPrompt(metadata, key),
        initialEvent: { eventId: created.eventId, ciphertext: await encryptPrompt(created, key) },
      });
      return { documentId, title };
    }
    const doc = await this.document(args.documentId, key);
    const pad = await joinPromptPad(origin, doc.metadata.editHref);
    try {
      if (pad.channel !== doc.channelHash) throw new Error("Prompt channel mismatch");
      const raw = pad.raw();
      const current = pad.read();
      if (!current || typeof current.content !== "string") throw new Error("Prompt content is unavailable");
      if (name === "prompt_read")
        return { documentId: doc.documentId, title: doc.metadata.title, text: current.content };
      if (name === "prompt_save_version")
        return this.event(doc.documentId, { kind: "version_saved", by: "agent", text: current.content }, key);
      if (name === "prompt_edit") {
        if (!Array.isArray(args.patches) || !args.patches.length || args.patches.length > 100)
          throw new Error("Provide text patches");
        let text = current.content;
        for (const patch of args.patches) {
          if (typeof patch.oldText !== "string" || !patch.oldText || typeof patch.newText !== "string")
            throw new Error("Each patch requires nonempty oldText and newText");
          const index = text.indexOf(patch.oldText);
          if (index < 0 || text.indexOf(patch.oldText, index + 1) >= 0)
            throw new Error("Patch text must match exactly once; read and retry");
          text = text.slice(0, index) + patch.newText + text.slice(index + patch.oldText.length);
        }
        await pad.write({ ...current, content: text }, raw);
        await this.event(doc.documentId, { kind: "agent_edit", patches: args.patches }, key);
        return { documentId: doc.documentId, text };
      }
      throw new Error("Unknown prompt tool");
    } finally {
      pad.close();
    }
  }
}
