import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const promptsDir = path.join(rootDir, "prompts");
const forbiddenPatterns = [
  {
    label: "Reviewer To Do List",
    pattern: /Reviewer To Do List/,
  },
];

async function promptFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nestedFiles = await promptFiles(fullPath);
      files.push(...nestedFiles);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

const failures = [];
for (const file of await promptFiles(promptsDir)) {
  const text = await readFile(file, "utf8");
  for (const { label, pattern } of forbiddenPatterns) {
    if (pattern.test(text)) {
      failures.push(`${path.relative(rootDir, file)} contains ${label}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Prompt boundary check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("prompt boundary check ok");
