import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  loadProfileNftPrompt,
  profileNftImagePromptPath,
  privateProfileNftPromptPath,
  renderProfileNftPrompt,
} from "../server/profile-nft-prompts.js";
import {
  buildProfileNftUserData,
  profileNftGenerationContextDocument,
} from "../server/profile-nft-generation.js";

const loaded = loadProfileNftPrompt();
assert.equal(loaded.metadata.model, "gpt-image-2");
assert.ok(["tracked", "configured", "legacy_private", "placeholder", "env_secret"].includes(loaded.source));
assert.equal(loaded.source, "tracked");
assert.equal(loaded.sourcePath, profileNftImagePromptPath);
assert.ok(loaded.promptTemplate.includes("Use a full color palette"));
assert.ok(loaded.promptTemplate.includes("Do not default to red and black"));
assert.ok(!loaded.promptTemplate.includes("red for aggression"));

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

const configuredPrompt = loadProfileNftPrompt({
  PROFILE_NFT_PROMPT_PATH: profileNftImagePromptPath,
  PROFILE_NFT_PROMPT_B64: Buffer.from("Stale prompt").toString("base64"),
});
assert.equal(configuredPrompt.source, "tracked");
assert.equal(configuredPrompt.sourcePath, profileNftImagePromptPath);
assert.ok(configuredPrompt.promptTemplate.includes("Use a full color palette"));

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

assert.equal(
  profileNftGenerationContextDocument({
    state: {
      context: {
        document: {
          body: "Context body from app-state must feed the profile NFT prompt.",
        },
      },
    },
  }),
  "Context body from app-state must feed the profile NFT prompt."
);
assert.equal(
  profileNftGenerationContextDocument({
    payload: {
      contextDocument: "Explicit payload context wins.",
    },
    state: {
      context: {
        document: {
          body: "This should not win.",
        },
      },
    },
  }),
  "Explicit payload context wins."
);

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
