import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assessTaskIntent } from "../server/task-intent-assessment.js";

const cases = JSON.parse(await readFile(new URL("./task-intent-evaluation-cases.json",import.meta.url),"utf8"));
const results = [];
for (let start=0;start<cases.length;start+=2) {
  const batch=await Promise.all(cases.slice(start,start+2).map(async item=> {
    const output=await assessTaskIntent(item);
    const passed=output.relationship===item.expected && output.actionable && output.scopeClear;
    console.log(JSON.stringify({case:item.id,passed,relationship:output.relationship,provider:output.provider,model:output.model,latencyMs:output.latencyMs,error:output.error}));
    return {id:item.id,expected:item.expected,passed,output};
  }));
  results.push(...batch);
}
assert.ok(results.every(item=>item.passed),"Task intent evaluation failed; inspect the recorded cases before enabling this gate.");
