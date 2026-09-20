import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const dir = new URL("./", import.meta.url);
const baseline = "/mnt/HC_Volume_101713660/pfrpc/scratch/hive-repair-20260919/baseline/";
const phase = process.argv[2] || "before";
for (const role of ["api", "worker"]) {
  const source = JSON.parse(readFileSync(new URL(role + "-source-" + phase + ".json", dir)));
  for (const [file, hash] of Object.entries(source.files)) {
    const expected = createHash("sha256").update(readFileSync((phase === "before" ? baseline : "") + file)).digest("hex");
    assert.equal(hash, expected, role + ":" + file);
  }
  console.log(role + ": all " + Object.keys(source.files).length + " " + phase + " source hashes match " + (phase === "before" ? "preserved baseline" : "tested repair"));
}
