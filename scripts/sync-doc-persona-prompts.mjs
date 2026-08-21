import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(repoRoot, "..");
const destinationRoot = resolve(repoRoot, "prompts/docs");
const sources = [
  {
    id: "odv",
    source: resolve(workspaceRoot, "pftasks/prompts/odv/odv_lindy.md"),
    destination: resolve(destinationRoot, "odv_lindy_v1.md"),
  },
  {
    id: "coach",
    source: resolve(workspaceRoot, "pft-telegram-trading-coach/prompts/trading_coach.md"),
    destination: resolve(destinationRoot, "trading_coach_v1.md"),
  },
];

await mkdir(destinationRoot, { recursive: true });
const manifest = { prompts: [] };
for (const entry of sources) {
  const sourceContent = await readFile(entry.source, "utf8");
  const content = `${sourceContent.replace(/[ \t]+$/gm, "").trimEnd()}\n`;
  await writeFile(entry.destination, content, "utf8");
  manifest.prompts.push({
    id: entry.id,
    source: entry.source,
    destination: entry.destination.slice(repoRoot.length + 1),
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content),
  });
}
await writeFile(resolve(destinationRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify(manifest, null, 2));
