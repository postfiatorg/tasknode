import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const legacyRoot = resolve(repoRoot, "..", "pftasks");
const destinationRoot = resolve(repoRoot, "prompts", "chat_modules");

const promptSources = Object.freeze({
  "brainstorming.md": "prompts/chat/brainstorming.md",
  "motivation.md": "prompts/chat/motivation.md",
  "five_mirrors.md": "prompts/modules/five_mirrors.md",
  "i_ching_reading.md": "prompts/chat/i_ching_reading.md",
  "sprint_planner.md": "prompts/modules/sprint_planner.md",
  "validator.md": "prompts/modules/validator.md",
  "post_fiat_clarity.md": "prompts/modules/post_fiat_clarity.md",
});

await mkdir(destinationRoot, { recursive: true });
for (const [destinationName, sourcePath] of Object.entries(promptSources)) {
  const source = await readFile(resolve(legacyRoot, sourcePath), "utf8");
  const normalized = `${source.replace(/[ \t]+$/gm, "").trimEnd()}\n`;
  await writeFile(resolve(destinationRoot, destinationName), normalized, "utf8");
}

const hexagramSource = resolve(legacyRoot, "shared", "i_ching", "hexagrams.json");
const hexagrams = JSON.parse(await readFile(hexagramSource, "utf8"));
if (!Array.isArray(hexagrams) || hexagrams.length !== 64) {
  throw new Error("legacy_i_ching_hexagram_dataset_invalid");
}
await mkdir(resolve(repoRoot, "prompts", "i_ching"), { recursive: true });
await writeFile(
  resolve(repoRoot, "prompts", "i_ching", "hexagrams.json"),
  `${JSON.stringify(hexagrams, null, 2)}\n`,
  "utf8"
);

console.log(`Synced ${Object.keys(promptSources).length} legacy chat modalities and 64 I Ching hexagrams.`);
