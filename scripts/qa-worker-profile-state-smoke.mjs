import assert from "node:assert/strict";

import {
  mergedProviderConnections,
  providerConnectionState,
} from "../src/features/profile/provider-connection-state.js";

const telegramFromSession = providerConnectionState({
  aliases: [],
  linkedProviders: [{
    id: "telegram",
    kind: "oauth",
    status: "linked",
    username: "qa_user",
  }],
  provider: "telegram",
});
assert.equal(telegramFromSession.linked, true, "badge state must honor the same session link shown in Settings");
assert.equal(telegramFromSession.verified, true, "a completed OAuth link is verified provider proof");

const discordFromAlias = providerConnectionState({
  aliases: [{
    provider: "discord",
    verified: true,
    username: "qa_user",
  }],
  linkedProviders: [],
  provider: "discord",
});
assert.equal(discordFromAlias.linked, true, "profile aliases remain a supported connection source");
assert.equal(discordFromAlias.verified, true);

const xCompatibility = providerConnectionState({
  aliases: [{ provider: "twitter", verified: true }],
  provider: "x",
});
assert.equal(xCompatibility.linked, true, "legacy Twitter aliases must continue to satisfy X linkage");

const merged = mergedProviderConnections({
  aliases: [{ provider: "telegram", label: "Telegram", verified: true, displayName: "Current Telegram" }],
  linkedProviders: [{ id: "telegram", kind: "oauth", status: "linked", username: "qa_user" }],
});
assert.equal(merged.length, 1, "the same provider must not render twice");
assert.equal(merged[0].username, "qa_user");
assert.equal(merged[0].displayName, "Current Telegram");
assert.equal(merged[0].verified, true);

const missingTelegram = providerConnectionState({
  linkedProviders: [{ id: "discord", kind: "oauth", status: "linked" }],
  provider: "telegram",
});
assert.equal(missingTelegram.linked, false, "a different linked provider must not satisfy Telegram");

console.log("qa worker profile state smoke ok");
