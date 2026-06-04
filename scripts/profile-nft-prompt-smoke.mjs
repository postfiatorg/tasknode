import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  loadProfileNftPrompt,
  privateProfileNftPromptPath,
  renderProfileNftPrompt,
} from "../server/profile-nft-prompts.js";
import { buildProfileNftUserData } from "../server/profile-nft-generation.js";

const loaded = loadProfileNftPrompt();
assert.equal(loaded.metadata.model, "gpt-image-2");
assert.ok(["private", "placeholder", "env_secret"].includes(loaded.source));

const secretPrompt = loadProfileNftPrompt({
  PROFILE_NFT_PROMPT_B64: Buffer.from([
    "---",
    "name: smoke-secret-profile-nft",
    "model: openai/gpt-image-2",
    "---",
    "Secret prompt ___NFT_USER_DATA_REPLACED_HERE___",
    "Context ___USER_CONTEXT_DOCUMENT_CONTENT_REPLACED_HERE___",
    "Boot < insert Random String>",
  ].join("\n")).toString("base64"),
});
assert.equal(secretPrompt.source, "env_secret");
assert.equal(secretPrompt.sourcePath, "PROFILE_NFT_PROMPT_B64");
assert.equal(secretPrompt.metadata.model, "gpt-image-2");
assert.ok(secretPrompt.promptTemplate.includes("Secret prompt"));

const nftUserData = buildProfileNftUserData({
  session: {
    accountId: "account_smoke",
    displayName: "Smoke User",
    primaryProvider: "github",
  },
  state: {
    wallet: {
      pftWallet: {
        status: "linked",
        address: "rSmokeWallet",
      },
    },
    tasks: {
      outstanding: [{ title: "Ship profile NFT prompt loader", status: "accepted", rewardPft: "2.5" }],
      verification: [],
      refused: [],
      rewarded: [{ title: "Implement context editor", status: "rewarded", rewardPft: "3.0" }],
    },
  },
});

const rendered = renderProfileNftPrompt({
  nftUserData,
  contextDocument: "Task Node is the current product priority. The profile must show credible work identity.",
  bootString: "smoke_boot_string",
});

assert.equal(rendered.unresolvedPlaceholders.length, 0);
assert.ok(rendered.prompt.includes("Smoke User") || rendered.prompt.includes("account_smoke"));
assert.ok(rendered.prompt.includes("Task Node is the current product priority"));
assert.ok(rendered.prompt.includes("smoke_boot_string"));
assert.ok(rendered.promptDigest.length === 64);

console.log(JSON.stringify({
  ok: true,
  source: rendered.source,
  privatePromptPresent: existsSync(privateProfileNftPromptPath),
  promptDigest: rendered.promptDigest.slice(0, 12),
}));
