import { bodyPolicy } from "./request-validation.js";

const KiB = 1024;
const MiB = 1024 * KiB;

const text = (maxLength, minLength = 0, extra = {}) => ({
  type: "string",
  minLength,
  maxLength,
  ...extra,
});
const boolean = { type: "boolean" };
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum });
const number = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "number", minimum, maximum });
const opaqueObject = { type: "object", allowUnknown: true };
const nullableOpaqueObject = { type: ["object", "null"], allowUnknown: true };
const stringArray = (maxItems = 20, maxLength = 500) => ({
  type: "array",
  maxItems,
  items: text(maxLength),
});

const proof = {
  type: "object",
  allowUnknown: false,
  properties: {
    challengeId: text(180),
    challenge_id: text(180),
    signature: text(1000),
    publicKey: text(240),
    public_key: text(240),
  },
};

const encryptedEnvelope = {
  type: "object",
  allowUnknown: true,
  properties: {
    ciphertext: text(8 * MiB),
    nonce: text(1000),
    content_hash: text(180),
    recipients: { type: "array", maxItems: 24, items: opaqueObject },
  },
};

const attachment = {
  type: "object",
  allowUnknown: false,
  properties: {
    name: text(160),
    mimeType: text(120),
    type: text(120),
    size: number(0, 12 * MiB),
    source: text(40, 0, { enum: ["", "paste", "upload", "drag_drop"] }),
    dataUrl: text(6 * MiB),
  },
};

const attachments = { type: "array", maxItems: 4, items: attachment };
const clientHistory = {
  type: "array",
  maxItems: 20,
  items: {
    type: "object",
    allowUnknown: false,
    properties: {
      role: text(20, 0, { enum: ["user", "assistant"] }),
      body: text(4000),
      text: text(4000),
      content: text(4000),
    },
  },
};
const docsRecentMessages = {
  type: "array",
  maxItems: 12,
  items: {
    type: "object",
    allowUnknown: false,
    properties: { author: text(120), text: text(2000) },
  },
};

const chatProperties = {
  accountId: text(180),
  message: text(200_000),
  body: text(200_000),
  mode: text(80),
  contextMode: text(80),
  persona: text(120),
  conversationId: text(180),
  conversationTitle: text(160),
  dryRun: boolean,
  attachments,
  clientHistory,
  clientRequestId: text(180),
  userMessageId: text(180),
  assistantMessageId: text(180),
  metadata: opaqueObject,
  metadata_json: opaqueObject,
  agentOrigin: opaqueObject,
  agentHandle: text(80),
  agent: text(80),
  client: text(120),
  projectComment: opaqueObject,
  boardComment: opaqueObject,
};

const taskProperties = {
  phase: text(40),
  taskId: text(180),
  task_id: text(180),
  taskAction: text(80),
  task_action: text(80),
  action: text(80),
  mode: text(80),
  reason: text(8000),
  requestId: text(100),
  bundleId: text(100),
  // Corbanu Terminal 0.1.35 sends this retry token in mutation JSON bodies.
  // It is part of the terminal contract, not an unknown client field.
  idempotencyKey: text(240),
  requestText: text(8000),
  userDetailText: text(8000),
  message: text(8000),
  requestedTaskKind: text(80),
  tasknodeEncryptionPubkey: text(4000),
  tasknode_encryption_pubkey: text(4000),
  subjectEncryptionPubkey: text(4000),
  source: text(80),
  sourceConversationTitle: text(160),
  conversationId: text(180),
  attachments,
  encryptedEventPayload: encryptedEnvelope,
  encryptedBundlePayload: encryptedEnvelope,
  encryptedPayload: encryptedEnvelope,
  encrypted_payload: encryptedEnvelope,
  signedTxBlob: text(1_000_000),
  signed_tx_blob: text(1_000_000),
  cid: text(240),
  eventCid: text(240),
  bundleCid: text(240),
  bundleDigest: text(180),
  pointer: opaqueObject,
  transaction: opaqueObject,
  offchainPayload: opaqueObject,
  actorSignature: nullableOpaqueObject,
  actor_signature: nullableOpaqueObject,
  file: opaqueObject,
  method: text(80),
  artifactType: text(80),
  artifact_type: text(80),
  value: text(1_000_000),
  summary: text(24_000),
  verificationCriteria: text(24_000),
  verification_criteria: text(24_000),
  evidence: { type: "array", maxItems: 32, items: opaqueObject },
  evidence_items: { type: "array", maxItems: 32, items: opaqueObject },
  status: text(80),
  requestEventCid: text(240),
  requestBundleCid: text(240),
  txHash: text(180),
  assistantMessage: text(1000),
  accountId: text(180),
  walletAddress: text(120),
  metadata: opaqueObject,
  agentOrigin: opaqueObject,
  agentHandle: text(80),
  client: text(120),
};

function strictBody(maxBytes, properties = {}, options = {}) {
  return bodyPolicy(maxBytes, { allowUnknown: false, properties, ...options });
}

export const emptyRequestBody = strictBody(KiB);
export const authDevBody = strictBody(4096, { email: text(320) });
export const passwordLoginBody = strictBody(4096, {
  identifier: text(320, 3),
  email: text(320, 3),
  password: text(1024, 1),
}, { required: ["password"], requiredAny: [["identifier", "email"]] });
export const passwordResetStartBody = strictBody(4096, {
  email: text(320, 3),
}, { required: ["email"] });
export const passwordEnableVerifyBody = strictBody(4096, {
  challengeId: text(180, 1),
  address: text(120, 1),
  publicKey: text(240, 1),
  signature: text(1000, 1),
  password: text(1024, 1),
}, { required: ["challengeId", "address", "publicKey", "signature", "password"] });
export const passwordResetVerifyBody = strictBody(4096, {
  challengeId: text(180, 1),
  code: text(32, 6),
  password: text(1024, 1),
}, { required: ["challengeId", "code", "password"] });
export const passwordChangeBody = strictBody(4096, {
  currentPassword: text(1024, 1),
  newPassword: text(1024, 1),
}, { required: ["currentPassword", "newPassword"] });
export const passwordDisableBody = strictBody(2048, {
  currentPassword: text(1024, 1),
}, { required: ["currentPassword"] });
export const accountTargetBody = strictBody(2048, {
  targetAccountId: text(180, 1),
}, { required: ["targetAccountId"] });
export const terminalAuthStartBody = strictBody(4096, { pollIntervalMs: integer(250, 60_000) });
export const observabilityBody = strictBody(8192, {
  eventType: text(160), event_type: text(160),
  walletAddress: text(120), wallet_address: text(120),
  walletScope: text(80), wallet_scope: text(80),
  taskId: text(180), task_id: text(180),
  conversationId: text(180), conversation_id: text(180),
  projectId: text(180), project_id: text(180),
  sourceSurface: text(120), source_surface: text(120),
  sourceRoute: text(240), source_route: text(240),
  resultStatus: text(120), result_status: text(120),
  reasonCode: text(180), reason_code: text(180),
  decision: opaqueObject, decision_json: opaqueObject,
  metrics: opaqueObject, metrics_json: opaqueObject,
  metadata: opaqueObject, metadata_json: opaqueObject,
}, { requiredAny: [["eventType", "event_type"]] });

export const chatBody = strictBody(8 * MiB, chatProperties);
export const terminalContextBody = strictBody(256 * KiB, {
  revision: integer(0), title: text(120), body: text(250_000), source: text(80),
}, { required: ["body"] });
export const chatConversationPatchBody = strictBody(16 * KiB, {
  conversationId: text(180), id: text(180), title: text(200),
}, { requiredAny: [["conversationId", "id"], ["title"]] });
export const chatConversationDeleteBody = strictBody(16 * KiB, {
  conversationId: text(180), id: text(180),
}, { requiredAny: [["conversationId", "id"]] });
export const taskBody = strictBody(8 * MiB, taskProperties);
export const terminalTaskBody = strictBody(64 * KiB, taskProperties);
export const taskEvidenceBody = strictBody(MiB, taskProperties);

export const iChingBody = strictBody(16 * KiB, {
  birthDate: text(10, 10), birthTime: text(8, 4), birthLocation: text(240, 1),
  gender: text(20, 1, { enum: ["male", "female"] }),
}, { required: ["birthDate", "birthTime", "birthLocation", "gender"] });
export const memoryDeleteBody = strictBody(8192, {
  action: text(40, 1, { enum: ["delete_entry", "clear_deep_memory", "clear_turn_memory", "reset_network_profile"] }),
  id: text(180), entryId: text(180),
}, { required: ["action"] });

export const collaborationChallengeBody = strictBody(512 * KiB, {
  action: text(80, 1), resourceId: text(240), payload: opaqueObject,
}, { required: ["action"] });
export const docsSetupBody = strictBody(512 * KiB, {
  encryptedRootKeyEnvelope: encryptedEnvelope, proof,
}, { required: ["encryptedRootKeyEnvelope", "proof"] });
export const docsCreateBody = strictBody(512 * KiB, {
  documentId: text(80, 1), channelHash: text(128, 1), encryptedMetadata: encryptedEnvelope, proof,
}, { required: ["documentId", "channelHash", "encryptedMetadata", "proof"] });
export const docsUpdateBody = strictBody(512 * KiB, {
  encryptedMetadata: encryptedEnvelope,
  status: text(40, 0, { enum: ["active", "archived", "deleting", "deleted"] }),
}, { requiredAny: [["encryptedMetadata", "status"]] });
export const docsAssistantBody = strictBody(128 * KiB, {
  channelHash: text(128, 1), prompt: text(24_000), documentTitle: text(1000),
  documentContent: text(80_000), recentMessages: docsRecentMessages,
  persona: text(120), includeFullContext: boolean,
}, { required: ["channelHash", "prompt", "documentContent"] });
export const docsShareBody = strictBody(512 * KiB, {
  recipientAccountId: text(180, 1), recipientWalletAddress: text(120, 1),
  accessRole: text(20, 0, { enum: ["viewer", "editor"] }),
  encryptedCapabilityEnvelope: encryptedEnvelope, proof,
}, { required: ["recipientAccountId", "recipientWalletAddress", "encryptedCapabilityEnvelope", "proof"] });
export const docsTaskLinkBody = strictBody(16 * KiB, { taskId: text(180, 1) }, { required: ["taskId"] });
export const docsGrantActionBody = strictBody(16 * KiB, {
  action: text(20, 1, { enum: ["accept", "decline", "leave", "revoke"] }),
}, { required: ["action"] });
export const teamInviteBody = strictBody(128 * KiB, {
  inviteId: text(80, 1), inviteeAccountId: text(180, 1),
  relationship: text(40, 0, { enum: ["collaborator", "manager", "direct_report"] }), proof,
}, { required: ["inviteId", "inviteeAccountId", "proof"] });
export const teamInviteActionBody = strictBody(128 * KiB, {
  action: text(20, 1, { enum: ["accept", "decline", "cancel"] }), proof,
}, { required: ["action"] });
export const proofBody = strictBody(128 * KiB, { proof }, { required: ["proof"] });
export const nostrBindBody = strictBody(128 * KiB, {
  nostrPubkeyHex: text(64, 64), npub: text(120, 1), preferredRelays: stringArray(5, 500),
  visibility: text(20, 0, { enum: ["private", "teammates", "public"] }), proof,
}, { required: ["nostrPubkeyHex", "npub", "proof"] });

export const hiveChatBody = strictBody(8 * MiB, chatProperties);
export const hiveHarvestResolveBody = strictBody(8192, {
  outcome: text(80), resolutionOutcome: text(80), note: text(4000), resolutionNote: text(4000),
}, { requiredAny: [["outcome", "resolutionOutcome"]] });
export const hiveReportRerunBody = strictBody(4096, { type: text(80, 1) }, { required: ["type"] });
export const capabilityProfileBody = strictBody(32 * KiB, {
  action: text(80, 0, { enum: ["verify", "revoke"] }),
  accountId: text(180), account_id: text(180), projectId: text(180), project_id: text(180),
  capabilityType: text(120), capability_type: text(120), scope: text(500), scope_ref: text(500), scopeRef: text(500),
  scopeLabel: text(180), scope_label: text(180), evidenceTaskId: text(180), evidence_task_id: text(180),
  taskId: text(180), task_id: text(180), evidenceUrlOrRef: text(500), evidence_url_or_ref: text(500),
  evidenceUrl: text(500), evidence_url: text(500), verifiedBy: text(180), verified_by: text(180),
  revokedBy: text(180), revoked_by: text(180), actor: text(180), expiresAt: { type: ["string", "null"], maxLength: 80 },
  expires_at: { type: ["string", "null"], maxLength: 80 }, notes: text(700), metadata: opaqueObject,
}, { requiredAny: [["accountId", "account_id"]] });

export const profileExpertBody = strictBody(8192, { topic: text(160) });
export const profileHandleBody = strictBody(8192, { handle: text(80, 1), displayName: text(120) }, { required: ["handle"] });
export const profileAliasBody = strictBody(8192, {
  provider: text(80, 1), visibility: text(20, 1, { enum: ["private", "public"] }),
  discloseHandle: boolean, discloseVerifiedBadge: boolean,
}, { required: ["provider", "visibility"] });
export const profileBadgeDefaultBody = strictBody(8192, {
  badgeId: text(80), badge_id: text(80),
}, { requiredAny: [["badgeId", "badge_id"]] });
export const profileVisibilityBody = strictBody(8192, {
  visibility: text(20, 1, { enum: ["private", "public"] }),
}, { required: ["visibility"] });
export const recommendedRefreshBody = strictBody(8192, { force: boolean, trigger: text(120) });
export const recommendedEventBody = strictBody(64 * KiB, {
  candidateAccountId: text(180), candidate_account_id: text(180),
  connectionId: text(180), connection_id: text(180),
  eventType: text(120), event_type: text(120), metadata: opaqueObject,
}, { requiredAny: [["candidateAccountId", "candidate_account_id"], ["eventType", "event_type"]] });
export const profileNftGenerateBody = strictBody(64 * KiB, {
  style: text(1200), note: text(1200), contextDocument: text(20_000), nftUserData: text(20_000),
  size: text(32), quality: text(32), outputFormat: text(32), phase: text(40),
});
export const profileNftMintBody = strictBody(128 * KiB, {
  phase: text(40), nftId: text(120), signedTxBlob: text(100_000),
}, { required: ["nftId"] });
export const profileNftSelectBody = strictBody(64 * KiB, { nftId: text(180, 1) }, { required: ["nftId"] });

export const walletPrepareBody = strictBody(8192, {
  destination: text(120, 1), amountPft: text(80, 1),
}, { required: ["destination", "amountPft"] });
export const walletSubmitBody = strictBody(8192, {
  signedTxBlob: text(1_000_000), signed_tx_blob: text(1_000_000),
  expectedDestination: text(120), expectedAmountDrops: text(80),
}, { requiredAny: [["signedTxBlob", "signed_tx_blob"]] });
export const walletLinkVerifyBody = strictBody(8192, {
  challengeId: text(180, 1), address: text(120, 1), publicKey: text(240, 1),
  tasknodeEncryptionPubkey: text(4000), tasknode_encryption_pubkey: text(4000), signature: text(1000, 1),
}, { required: ["challengeId", "address", "publicKey", "signature"] });
export const walletInitiationRetryBody = strictBody(8192, { localVaultConfirmed: boolean });
export const walletDelinkBody = strictBody(8192, {
  confirmAddress: text(120, 1), confirmDocsAccessLoss: boolean, reason: text(180),
}, { required: ["confirmAddress", "confirmDocsAccessLoss"] });

export const contextRewriteBody = strictBody(1_200_000, {
  message: text(12_000), instruction: text(12_000), instructions: text(12_000), conversationId: text(180),
}, { requiredAny: [["message", "instruction", "instructions"]] });
export const deepResearchBody = strictBody(128 * KiB, {
  question: text(50_000, 1),
  message: text(50_000, 1),
  title: text(500),
  conversationId: text(180, 1),
  requestId: text(180, 1),
}, {
  required: ["conversationId", "requestId"],
  requiredAny: [["question", "message"]],
});
export const contextSaveBody = strictBody(64 * KiB, {
  title: text(120), body: text(60_000), revision: integer(0),
}, { required: ["body"] });
export const contextManifestBody = strictBody(1_200_000, {
  phase: text(40), encryptedPayload: encryptedEnvelope, encrypted_payload: encryptedEnvelope,
  signedTxBlob: text(1_000_000), signed_tx_blob: text(1_000_000), cid: text(240),
  pointer: opaqueObject, transaction: opaqueObject, context: opaqueObject,
  title: text(120), body: text(1_000_000), wordCount: integer(0), revision: integer(0),
});

export const teamContextPreferenceBody = strictBody(4096, {
  includeInPersonalContext: boolean,
}, { required: ["includeInPersonalContext"] });

export const usageAdminCreditBody = strictBody(4096, {
  amountUsd: number(0.01, 10_000), accountId: text(180, 1), idempotencyKey: text(240), note: text(1000), actor: text(180),
}, { required: ["amountUsd", "accountId"] });

export const boardAdminBody = strictBody(64 * KiB, {
  boardId: text(120), board_id: text(120), id: text(120), status: text(40), priority: number(0),
  phaseCurrent: number(0), phase_current: number(0), phaseTotal: number(0), phase_total: number(0),
  title: text(2000), summary: text(2000), about: text(8000), phaseLabel: text(2000), phase_label: text(2000),
  metadataPatch: opaqueObject, metadata_patch: opaqueObject, actor: text(180),
}, { requiredAny: [["boardId", "board_id", "id"]] });

// Telegram owns this evolving webhook document. We still cap its size, require
// an object, and type the stable update discriminator while preserving forward
// compatibility for new Telegram event variants.
export const telegramWebhookBody = bodyPolicy(MiB, {
  allowUnknown: true,
  properties: { update_id: integer(0) },
});

export const networkBadgeAdminBody = strictBody(64 * KiB, {
  action: text(80), submit: boolean,
  accountId: text(180), account_id: text(180), badgeId: text(80), badge_id: text(80),
  jobId: text(180), job_id: text(180), requirementId: text(180), requirement_id: text(180), id: text(180),
  projectId: text(180), project_id: text(180), workType: text(120), work_type: text(120),
  taskWorkType: text(120), task_work_type: text(120), provider: text(80), verifierType: text(120), verifier_type: text(120),
  type: text(120), capabilityType: text(120), capability_type: text(120), scopeLabel: text(180), scope_label: text(180),
  scopeDigest: text(80), scope_digest: text(80), maxPayoutOverridePft: number(0), max_payout_override_pft: number(0),
  publicHandle: text(180), public_handle: text(180), handle: text(180), profileUrl: text(500), profile_url: text(500),
  username: text(180), userId: text(180), user_id: text(180), owner: text(180), githubOwner: text(180), github_owner: text(180),
  repo: text(180), repository: text(180), githubRepo: text(180), github_repo: text(180), requiredOwner: text(180), required_owner: text(180),
  providerToken: text(4000), provider_token: text(4000), token: text(4000), approvalLevel: text(80), approval_level: text(80),
  approvedByAccountId: text(180), approved_by_account_id: text(180), operator: text(180), verifiedBy: text(180), verified_by: text(180), actor: text(180),
  approvalScope: text(240), approval_scope: text(240), reason: text(700), notes: text(700), status: text(80),
  maxAttempts: integer(1, 20), max_attempts: integer(1, 20), runAfter: text(80), run_after: text(80),
  selectedDefault: boolean, selected_default: boolean, default: boolean, evidence: opaqueObject, metrics: opaqueObject,
});
