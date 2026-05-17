# IPFS Standards

IPFS stores content-addressed payloads that PFTL pointers reference by CID. Private payloads should be encrypted before upload. Public metadata can be attached to the pin when it does not leak private content.

## Payload Classes

- Context documents.
- Task requests.
- Task proposals.
- Task submissions.
- Verification evidence packets.
- Reward receipts.

## Technical Architecture

Server IPFS helpers live in `server/context-ipfs.js`. Context publishing uses `server/context-publish.js` and `src/features/context/context-publish.js`. Python reference IPFS upload and fetch code lives in `reference_clients/python/tasknode_pftl/ipfs.py`.

Pinata is the current simple pinning path. A self-hosted IPFS node can be added as another adapter as long as the CID and payload schema stay stable.

## Diagram

```mermaid
flowchart LR
  Payload[Canonical JSON Payload] --> Encrypt[Encrypt If Private]
  Encrypt --> Pin[Pinata or IPFS Adapter]
  Pin --> CID[CID]
  CID --> Pointer[PFTL Pointer Memo]
  Pointer --> Replay[Replay Client Fetches CID]
```

## Failure Modes

- Never upload private context or task content in plaintext.
- CID fetch failure should not erase the on-chain pointer.
- Payload schema should be versioned.
- Pinning metadata should not include secrets.

