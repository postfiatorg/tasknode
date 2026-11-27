import { bodyPolicy } from "../request-validation.js";

const tenMinutes = 10 * 60_000;
const text = (maxLength, minLength = 0, extra = {}) => ({ type: "string", minLength, maxLength, ...extra });
const boolean = { type: "boolean" };
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum });

const handleAttestationSchema = {
  type: "object",
  allowUnknown: false,
  properties: {
    namespace: text(128, 1),
    handle: text(32, 2),
    account: text(64, 42),
    expires_at_height: integer(1),
    registrar_account: text(64, 42),
    registrar_pubkey_hex: text(4096),
    registrar_signature_hex: text(8192),
  },
};

const identityReserveBody = bodyPolicy(8192, {
  allowUnknown: false,
  required: ["handle"],
  properties: {
    handle: text(64, 2),
    l1Account: text(64),
    nostrPubkeyHex: text(64),
    optIntoV2: boolean,
    identityKind: text(20, 0, { enum: ["human", "agent", "service"] }),
  },
});

const identityAttestBody = bodyPolicy(8192, {
  allowUnknown: false,
  required: ["account", "handle"],
  properties: {
    account: text(64, 42),
    handle: text(64, 2),
    nostrPubkeyHex: text(64),
    reservationSaltHex: text(128),
    identityKind: text(20, 0, { enum: ["human", "agent", "service"] }),
    chainId: text(64),
    currentHeight: integer(1),
  },
});

const identityBuildTxBody = bodyPolicy(32_768, {
  allowUnknown: false,
  required: ["action", "account"],
  properties: {
    action: text(32, 1, {
      enum: ["mint", "update", "link", "unlink", "rotate", "rotate_account", "revoke"],
    }),
    account: text(64, 42),
    chainId: text(64),
    sequence: integer(1),
    nostrPubkeyHex: text(64),
    nostrProofSigHex: text(128),
    derivationVersion: integer(1, 2),
    keyIndex: integer(0, 1_000_000),
    identityKind: text(20, 0, { enum: ["human", "agent", "service"] }),
    handleAttestation: handleAttestationSchema,
    reservationSaltHex: text(128),
    relays: { type: "array", maxItems: 5, items: text(128, 6) },
    avatarNftId: { type: ["string", "null"], maxLength: 96 },
    messageKey: { type: ["string", "null"], maxLength: 2432 },
    pqReceiveAddress: { type: ["string", "null"], maxLength: 128 },
    kind: text(32),
    target: text(256),
    proofPubkeyHex: text(4096),
    proofSigHex: text(8192),
    metadataHash: text(96),
    existingLinkCount: integer(0, 16),
    linkId: text(96),
    selfUnlinkPubkeyHex: text(4096),
    selfUnlinkSigHex: text(8192),
    mode: text(20, 0, { enum: ["planned", "compromised"] }),
    newNostrPubkeyHex: text(64),
    newNostrProofSigHex: text(128),
    newAccount: text(64),
    newAccountPubkeyHex: text(4096),
    newAccountSigHex: text(8192),
    reasonCode: text(64),
  },
});

const customNip05VerifyBody = bodyPolicy(4096, {
  allowUnknown: false,
  required: ["identifier", "nostrPubkeyHex"],
  properties: {
    identifier: text(320, 4),
    nostrPubkeyHex: text(64, 64),
    account: text(64),
    existingLinkCount: integer(0, 16),
  },
});

export const identityRoutePolicies = [
  {
    id: "identity_onchain_status",
    path: "/api/identity/status",
    methods: ["GET"],
    auth: "session",
    unauthenticatedError: "identity_login_required",
    rateLimit: { limit: 120, windowMs: tenMinutes },
  },
  {
    id: "identity_check_handle",
    path: "/api/identity/check-handle",
    methods: ["GET"],
    auth: "optional",
    rateLimit: { limit: 120, windowMs: tenMinutes },
  },
  {
    id: "identity_handle_reserve",
    path: "/api/identity/reserve",
    methods: ["POST"],
    auth: "session",
    unauthenticatedError: "identity_login_required",
    rateLimit: { limit: 20, windowMs: tenMinutes },
    body: identityReserveBody,
  },
  {
    id: "identity_handle_attest",
    path: "/api/identity/attest",
    methods: ["POST"],
    auth: "session",
    unauthenticatedError: "identity_login_required",
    rateLimit: { limit: 20, windowMs: tenMinutes },
    body: identityAttestBody,
  },
  {
    id: "identity_build_tx",
    path: "/api/identity/build-tx",
    methods: ["POST"],
    auth: "session",
    unauthenticatedError: "identity_login_required",
    rateLimit: { limit: 60, windowMs: tenMinutes },
    body: identityBuildTxBody,
  },
  {
    id: "identity_custom_nip05_verify",
    path: "/api/identity/custom-nip05/verify",
    methods: ["POST"],
    auth: "session",
    unauthenticatedError: "identity_login_required",
    rateLimit: { limit: 20, windowMs: tenMinutes },
    body: customNip05VerifyBody,
  },
];
