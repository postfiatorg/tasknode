import { readFileSync, statSync, writeFileSync } from "node:fs";
import readline from "node:readline";
import { PromptClient } from "./prompt-client.mjs";
import { pairPromptDevice } from "./prompt-device.mjs";
const str = { type: "string" };
const id = { documentId: str };
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
export const promptTools = [
  [
    "prompt_pair",
    "Finish connecting this agent to the prompt library. Pass the pairing code shown in Task Node Docs → Agent access.",
    schema({ code: str }, ["code"]),
  ],
  ["prompt_list", "List your encrypted prompt library.", schema({})],
  [
    "prompt_create",
    "Deliberately create a markdown prompt. Name gets a date suffix.",
    schema({ name: str, text: str }, ["name"]),
  ],
  ["prompt_read", "Read current prompt text locally from its encrypted collaborative pad.", schema(id, ["documentId"])],
  [
    "prompt_edit",
    "Apply exact unique text replacements, visible live in the editor. Read first.",
    schema(
      { ...id, patches: { type: "array", items: schema({ oldText: str, newText: str }, ["oldText", "newText"]) } },
      ["documentId", "patches"],
    ),
  ],
  ["prompt_save_version", "Save the full current text into encrypted history.", schema(id, ["documentId"])],
  ["prompt_history", "Decrypt history locally, optionally for one prompt.", schema(id)],
  [
    "prompt_stats",
    "Compute UTC daily prompt, version and active-time statistics locally.",
    schema({ days: { type: "integer", enum: [7, 30] } }),
  ],
  [
    "prompt_log_tih_run",
    "Record scores from TIH run by your agent locally.",
    schema({ ...id, before: { type: "number" }, after: { type: "number" } }, ["documentId", "before", "after"]),
  ],
].map(([name, description, inputSchema]) => ({ name, description, inputSchema }));
export async function servePromptMcp(deviceFile) {
  if (process.platform !== "win32" && statSync(deviceFile).mode & 0o077)
    throw new Error("Device file must have mode 0600");
  let device = JSON.parse(readFileSync(deviceFile, "utf8"));
  let client = new PromptClient(device);
  const pair = async (code) => {
    const { envelope } = await client.request("device-key");
    device = await pairPromptDevice(envelope, device, String(code || "").trim().toLowerCase());
    writeFileSync(deviceFile, JSON.stringify(device), { mode: 0o600 });
    client = new PromptClient(device);
    return { paired: true };
  };
  const failureText = () => {
    if (!device.keyCommitment)
      return "This agent is not paired with the prompt library yet. In Task Node open Docs → Prompts → Agent access, approve this device, then call prompt_pair with the pairing code shown there.";
    return "Prompt operation failed. Check device approval, document access, and exact patch matches; read before retrying.";
  };
  // Protocol dependencies may log: reserve stdout exclusively for MCP JSON-RPC.
  console.log = () => {};
  console.debug = () => {};
  console.warn = () => {};
  console.error = () => {};
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    if (!Object.hasOwn(request, "id")) continue;
    let result;
    try {
      if (request.method === "initialize")
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "tasknode-prompts-local", version: "0.1.0" },
          instructions:
            "These prompt tools decrypt only on this machine. Never send prompt text or history to hosted Task Node assistant tools. TIH runs locally.",
        };
      else if (request.method === "ping") result = {};
      else if (request.method === "tools/list") result = { tools: promptTools };
      else if (request.method === "tools/call") {
        if (!promptTools.some((tool) => tool.name === request.params?.name)) throw new Error("Unknown tool");
        const args = request.params.arguments || {};
        const output =
          request.params.name === "prompt_pair" ? await pair(args.code) : await client.call(request.params.name, args);
        result = { content: [{ type: "text", text: JSON.stringify(output) }] };
      } else {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
        continue;
      }
      send({ jsonrpc: "2.0", id: request.id, result });
    } catch {
      // Never echo upstream errors, capabilities, ciphertext keys, or request arguments.
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text:
                request.params?.name === "prompt_pair"
                  ? "Pairing failed. Approve this device in Task Node Docs → Agent access first, then pass the exact pairing code shown there."
                  : failureText(),
            },
          ],
        },
      });
    }
  }
}
