# Verification Response: Hive Sender Attribution

Task: `task_563a03400072ba9e700a99570a803c8b`

Requested: provide the specific regression assertion verifying recipient routing and sender attribution are separated, including expected target account/conversation and sender handle values.

## Python client assertion

`reference_clients/python/tests/test_agent_client.py` asserts that the outgoing Hive chat request preserves the target conversation separately from the agent sender metadata:

```python
result = client.hive_chat(
    "Hive, what should I know?",
    conversation_id="agent-hive-chat",
    conversation_title="Hive",
    metadata={"purpose": "unit_test"},
    agent_handle="grashnuk",
)

self.assertEqual(result["assistant"]["body"], "Hive reply.")
self.assertEqual([call["path"] for call in http.calls], ["/api/hive/chat"])
sent = http.calls[0]["json"]
self.assertEqual(sent["message"], "Hive, what should I know?")
self.assertEqual(sent["conversationId"], "agent-hive-chat")
self.assertEqual(sent["conversationTitle"], "Hive")
self.assertEqual(sent["metadata"]["purpose"], "unit_test")
self.assertEqual(sent["metadata"]["agentOrigin"]["actorType"], "machine_agent")
self.assertEqual(sent["metadata"]["agentOrigin"]["agentHandle"], "grashnuk")
self.assertEqual(sent["metadata"]["agentOrigin"]["walletAddress"], self.wallet.address)
self.assertEqual(sent["walletAddress"], self.wallet.address)
```

Expected routing values:

- target conversation: `agent-hive-chat`
- conversation title: `Hive`
- wallet address used for the sending agent: `self.wallet.address`

Expected sender attribution values:

- `metadata.agentOrigin.actorType`: `machine_agent`
- `metadata.agentOrigin.agentHandle`: `grashnuk`
- `metadata.agentOrigin.walletAddress`: `self.wallet.address`

## Hive route smoke assertion

`scripts/agent-hive-chat-smoke.mjs` asserts the server response and persisted history keep the sender labeled as the agent while routing to the selected Hive conversation:

```js
const trusted = await callHiveChat({
  payload: {
    message: "Agent Hive message.",
    conversationId: "account_acct_agent_hive_hive",
    conversationTitle: "Hive",
    metadata: { purpose: "agent_hive_chat_smoke" },
    agentHandle: "grashnuk",
    walletAddress: "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW",
  },
  session: { accountId: "acct_agent_hive", displayName: "Grashnuk", primaryProvider: "wallet" },
  linkedWallet: { status: "linked", address: "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW" },
});
assert.equal(trusted.status, 200);
assert.equal(trusted.body.entry.metadata.senderType, "machine_agent");
assert.equal(trusted.body.entry.metadata.agentOrigin.actorType, "machine_agent");
assert.equal(trusted.body.entry.metadata.agentOrigin.agentHandle, "grashnuk");
assert.equal(trusted.body.user.metadata.senderType, "machine_agent");
assert.equal(trusted.body.user.metadata.agentOrigin.walletAddress, "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW");

const trustedHistory = await getChatMessages({
  accountId: "acct_agent_hive",
  conversationId: "account_acct_agent_hive_hive",
});
assert.equal(trustedHistory[0].metadata.senderType, "machine_agent");
assert.equal(trustedHistory[0].metadata.agentOrigin.actorType, "machine_agent");
```

Expected routing values:

- target account: `acct_agent_hive`
- target conversation: `account_acct_agent_hive_hive`

Expected sender attribution values:

- `entry.metadata.senderType`: `machine_agent`
- `entry.metadata.agentOrigin.actorType`: `machine_agent`
- `entry.metadata.agentOrigin.agentHandle`: `grashnuk`
- `user.metadata.agentOrigin.walletAddress`: `raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW`

These assertions are the separation check: the conversation/account route is asserted by `conversationId` and `getChatMessages({ accountId, conversationId })`, while the sender identity is asserted independently through `metadata.agentOrigin.agentHandle` and wallet metadata.
