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

`server/context-ipfs.js` enforces a 1 MB JSON pin limit. That limit is intentional: IPFS pointers should carry compact canonical JSON, not raw media blobs. Screenshot and binary evidence must be processed before signing so the encrypted payload contains extracted text, SHA-256 digest metadata, file metadata, and processing metadata rather than base64 image or file bytes. The current screenshot path uses `server/task-evidence-processing.js` and `prompts/task_engine/evidence_screenshot_read_v1.md` before the browser encrypts and publishes the task submission pointer.

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
- Raw screenshot/file base64 should not be embedded directly in task evidence JSON.
