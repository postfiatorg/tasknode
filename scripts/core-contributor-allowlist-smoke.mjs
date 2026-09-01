import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  configuredCoreContributorGithubHandles,
  githubCoreContributorAccess,
} from "../server/core-contributor-authorization.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const flyConfig = readFileSync(join(root, "fly.toml"), "utf8");
const prefix = '  TASKNODE_CORE_CONTRIBUTOR_GITHUB_HANDLES = "';
const configLine = flyConfig
  .split("\n")
  .find((line) => line.startsWith(prefix));

assert.ok(configLine, "production Core Contributor allowlist must be configured");
const handles = configLine
  .slice(prefix.length, configLine.lastIndexOf('"'))
  .split(",")
  .map((handle) => handle.trim().toLowerCase())
  .filter(Boolean);

assert.equal(new Set(handles).size, handles.length, "Core Contributor handles must be unique");
assert.deepEqual([...handles].sort(), handles, "Core Contributor handles must remain sorted");

const authorizedTeamProfiles = [
  "0xpostfiatchad",
  "corbanuai",
  "dravlic",
  "jimricketts",
  "secondfmaster",
];
for (const handle of authorizedTeamProfiles) {
  assert.ok(handles.includes(handle), `missing authorized team GitHub profile: ${handle}`);
}

const fixtureEnv = {
  TASKNODE_CORE_CONTRIBUTOR_GITHUB_HANDLES: " SecondFMaster,corbanuAI,secondfmaster ",
};
assert.deepEqual(
  configuredCoreContributorGithubHandles(fixtureEnv),
  ["secondfmaster", "corbanuai"],
  "authorization must normalize case, whitespace, and duplicates"
);
assert.equal(githubCoreContributorAccess("SECONDFMASTER", fixtureEnv).sanctioned, true);
assert.equal(githubCoreContributorAccess("adjacent-user", fixtureEnv).sanctioned, false);

console.log("core contributor allowlist smoke ok");
