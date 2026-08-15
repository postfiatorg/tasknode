# Messages

Messages is the private user-to-user inbox under **More**. Users address each other by Task Node handle; Nostr provides the encrypted transport behind the interface.

## First Use

1. Set a Task Node handle on Profile and make the profile discoverable.
2. Open **More -> Messages**.
3. Unlock the linked Task Node wallet.
4. Select **Activate Messages**. The confirmation shows the Task Node NIP-05 address, such as `handle@tasknode.postfiat.org`.

Activation is not automatic. It creates a wallet-bound public Nostr identity and publishes the handle mapping. The private key is deterministically reconstructed in the browser from the unlocked wallet and is never uploaded.

## Starting a Conversation

Select **New message**, enter an exact Task Node handle, and select the resolved member. A member is messageable only when the member has a discoverable Task Node handle and an active public Messages binding. The interface does not accept a fuzzy result that might address the wrong person.

Desktop uses a conversation list and transcript side by side. Mobile shows one pane at a time. The conversation header shows the resolved Task Node identity and NIP-05 address.

## Sending and Syncing

Messages are NIP-17 end-to-end encrypted in the browser and published to the configured Nostr relays. Task Node does not proxy or save message bodies. A send is reported as complete only after at least one relay accepts it.

While Messages is open and the wallet is unlocked, the browser maintains a live encrypted relay subscription. New gift-wrapped messages render as they arrive; the recipient does not need to select a sync control. Returning to the tab or regaining network connectivity automatically backfills retained relay events in case the live connection was interrupted.

**Retry** is a manual recovery control that requests encrypted inbox events from the relays and decrypts them locally. It is not part of the normal send/receive workflow. Because relay retention and availability vary, Nostr is a messaging transport rather than a guaranteed permanent archive. Unlocking the wallet is required after a browser restart or lock before history can be read.

## Privacy and Permissions

- Message content is not stored in Task Node Postgres.
- Contact labels may be remembered in that browser; private keys and message bodies are not written to browser storage.
- Relay operators can observe connection and ciphertext metadata.
- A Nostr message never grants Team, Docs, task, wallet, Context, or Memory access.
- Revoking Messages disables the Task Node handle binding but cannot delete copies already retained by independent relays.

See [Nostr Messaging Architecture](#docs/nostr) for protocol and failure details.
