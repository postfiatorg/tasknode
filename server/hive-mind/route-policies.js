import { bodyPolicy } from "../request-validation.js";

const tenMinutes = 10 * 60_000;
const text = (maxLength, minLength = 0, extra = {}) => ({
  type: "string",
  minLength,
  maxLength,
  ...extra,
});
const boolean = { type: "boolean" };
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum });
const number = (minimum = -1_000_000, maximum = 1_000_000) => ({ type: "number", minimum, maximum });

const profileBody = bodyPolicy(16_384, {
  allowUnknown: false,
  required: ["confirmed", "confirmedAreas", "confirmedInfoTypes"],
  properties: {
    confirmed: boolean,
    confirmedAreas: { type: "array", maxItems: 24, items: text(64, 1) },
    confirmedInfoTypes: {
      type: "array",
      maxItems: 5,
      items: text(32, 1, { enum: ["operator", "builder", "customer", "trader", "public_data_analyst"] }),
    },
    approvedSummary: text(600),
    attributionMode: text(24, 1, { enum: ["handle", "hive_identity", "pseudonym"] }),
    attributionLabel: text(80),
    maxConcurrentInterviews: integer(1, 10),
  },
});

const interviewStartBody = bodyPolicy(16_384, {
  allowUnknown: false,
  required: ["modelId", "relationship", "noMnpiAttested", "noNdaViolationAttested"],
  properties: {
    modelId: text(64, 1),
    relationship: text(48, 1),
    noMnpiAttested: boolean,
    noNdaViolationAttested: boolean,
    maxTurns: integer(2, 16),
    maxTokens: integer(500, 32_000),
  },
});

const interviewMessageBody = bodyPolicy(32_768, {
  allowUnknown: false,
  required: ["interviewId", "message"],
  properties: {
    interviewId: text(120, 1),
    message: text(12_000, 1),
    confirmRedacted: boolean,
  },
});

const claimSubmitBody = bodyPolicy(32_768, {
  allowUnknown: false,
  required: ["interviewId", "claimText", "infoType", "stance", "evidenceMechanism", "clientSignature"],
  properties: {
    interviewId: text(120, 1),
    claimText: text(4000, 1),
    infoType: text(32, 1, { enum: ["operator", "builder", "customer", "trader", "public_data_analyst"] }),
    stance: text(24, 1, { enum: ["confirms", "refines", "challenges"] }),
    evidenceMechanism: text(4000, 1),
    checkable: boolean,
    checkEventDate: text(32),
    checkEventDescription: text(400),
    attributionMode: text(24, 1, { enum: ["handle", "hive_identity", "pseudonym"] }),
    attributionLabel: text(80),
    confirmRedacted: boolean,
    clientSignature: {
      type: "object",
      allowUnknown: false,
      required: ["scheme", "publicKey", "signature", "signedAt"],
      properties: {
        scheme: text(32, 1, { enum: ["client_sha256_v1", "ed25519"] }),
        identityType: text(32, 1, { enum: ["pillar6_identity", "pseudonymous_key", "handle_key", "pseudonym"] }),
        publicKey: text(2048, 1),
        signature: text(1024, 1),
        signedAt: text(64, 1),
      },
    },
  },
});

const proposalDecideBody = bodyPolicy(8192, {
  allowUnknown: false,
  required: ["proposalId", "decision"],
  properties: {
    proposalId: text(120, 1),
    decision: text(16, 1, { enum: ["approve", "reject"] }),
    changelogOverride: text(1000),
  },
});

const bridgeWebhookBody = bodyPolicy(16_384, {
  allowUnknown: false,
  required: ["event", "proposalId", "modelId", "commitRef", "changelogRef", "nonce", "issuedAt", "signature"],
  properties: {
    event: text(40, 1, { enum: ["proposal_applied"] }),
    proposalId: text(120, 1),
    modelId: text(64, 1),
    commitRef: text(128, 1),
    changelogRef: text(256, 1),
    nonce: text(128, 1),
    issuedAt: text(64, 1),
    signature: text(128, 1),
  },
});

const claimResolveBody = bodyPolicy(8192, {
  allowUnknown: false,
  required: ["claimId", "outcome"],
  properties: {
    claimId: text(120, 1),
    outcome: text(24, 1, { enum: ["verified", "falsified", "unresolvable"] }),
    checkEventRef: text(160),
    forecastAccuracyDelta: number(-100, 100),
    isNonConsensus: boolean,
  },
});

const takedownBody = bodyPolicy(4096, {
  allowUnknown: false,
  required: ["reasonCode"],
  properties: {
    claimId: text(120),
    proposalId: text(120),
    reasonCode: text(80, 1),
  },
});

export const hiveMindRoutePolicies = Object.freeze([
  { id: "hive_mind_coverage", path: "/api/hive-mind/coverage", methods: ["GET"], auth: "optional" },
  {
    id: "hive_mind_profile",
    path: "/api/hive-mind/profile",
    methods: ["GET", "POST"],
    auth: "session",
    rateLimit: { limit: 60, windowMs: tenMinutes },
    body: profileBody,
  },
  { id: "hive_mind_matches", path: "/api/hive-mind/matches", methods: ["GET"], auth: "session", rateLimit: { limit: 60, windowMs: tenMinutes } },
  {
    id: "hive_mind_interview_start",
    path: "/api/hive-mind/interviews/start",
    methods: ["POST"],
    auth: "session",
    rateLimit: { limit: 20, windowMs: tenMinutes },
    body: interviewStartBody,
  },
  {
    id: "hive_mind_interview_message",
    path: "/api/hive-mind/interviews/message",
    methods: ["POST"],
    auth: "session",
    rateLimit: { limit: 60, windowMs: tenMinutes },
    body: interviewMessageBody,
  },
  {
    id: "hive_mind_claims_submit",
    path: "/api/hive-mind/claims",
    methods: ["POST"],
    auth: "session",
    rateLimit: { limit: 30, windowMs: tenMinutes },
    body: claimSubmitBody,
  },
  {
    id: "hive_mind_claims_resolve",
    path: "/api/hive-mind/claims/resolve",
    methods: ["POST"],
    auth: "session",
    rateLimit: { limit: 30, windowMs: tenMinutes },
    body: claimResolveBody,
  },
  { id: "hive_mind_proposals_list", path: "/api/hive-mind/proposals", methods: ["GET"], auth: "session" },
  {
    id: "hive_mind_proposals_decide",
    path: "/api/hive-mind/proposals/decide",
    methods: ["POST"],
    auth: "session",
    rateLimit: { limit: 30, windowMs: tenMinutes },
    body: proposalDecideBody,
  },
  {
    id: "hive_mind_bridge_proposals",
    path: "/api/hive-mind/bridge/proposals",
    methods: ["GET"],
    auth: "bearer",
    unauthenticatedError: "hive_mind_bridge_unauthorized",
  },
  {
    id: "hive_mind_bridge_webhook",
    path: "/api/hive-mind/bridge/webhook",
    methods: ["POST"],
    auth: "handler",
    rateLimit: { limit: 60, windowMs: tenMinutes },
    body: bridgeWebhookBody,
  },
  {
    id: "hive_mind_takedown",
    path: "/api/hive-mind/takedown",
    methods: ["POST"],
    auth: "session",
    rateLimit: { limit: 30, windowMs: tenMinutes },
    body: takedownBody,
  },
  { id: "hive_mind_insights", path: "/api/hive-mind/insights", methods: ["GET"], auth: "optional" },
  { id: "hive_mind_roi", path: "/api/hive-mind/roi", methods: ["GET"], auth: "session" },
]);
