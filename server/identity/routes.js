import {
  DEFAULT_IDENTITY_NAMESPACE,
  DEFAULT_IDENTITY_RELAYS,
  IDENTITY_LINK_STATE_EXPANSION_FEE,
  IDENTITY_MINT_STATE_EXPANSION_FEE,
} from "./constants.js";
import {
  buildControllerLinkMessage,
  buildIdentityLinkOperation,
  buildIdentityMintOperation,
  buildIdentityRevokeOperation,
  buildIdentityRotateAccountOperation,
  buildIdentityRotateOperation,
  buildIdentityUnlinkOperation,
  buildIdentityUpdateOperation,
  buildNostrProofMessage,
  buildOldChainLinkMessage,
  buildRotateAccountMessage,
  buildSelfUnlinkMessage,
  buildValidatorLinkMessage,
} from "./payload-builder.js";
import { createIdentityRegistrar } from "./registrar.js";
import { createPostgresIdentityStore } from "./store.js";
import { getNostrIdentity } from "../repositories/nostr-messages.js";

function envCsv(value = "") {
  return String(value || "").split(",").map((v) => v.trim()).filter(Boolean);
}

const defaultStore = createPostgresIdentityStore();

function defaultRegistrar() {
  return createIdentityRegistrar({
    namespace: process.env.TASKNODE_NOSTR_NIP05_DOMAIN || DEFAULT_IDENTITY_NAMESPACE,
    founderAccountIds: envCsv(process.env.TASKNODE_FOUNDER_ACCOUNT_IDS),
    agentAccountIds: envCsv(process.env.TASKNODE_AGENT_ACCOUNT_IDS),
    hotRegistrarAccount: process.env.TASKNODE_REGISTRAR_HOT_ACCOUNT || "",
    hotRegistrarPubkeyHex: process.env.TASKNODE_REGISTRAR_HOT_PUBKEY_HEX || "",
    coldSigners: envCsv(process.env.TASKNODE_REGISTRAR_COLD_SIGNERS),
    store: defaultStore,
  });
}

export function buildIdentitySetPayloadResponse(payload = {}) {
  const chainId = String(payload.chainId || "postfiat-wan-devnet-2");
  const seq = Number(payload.sequence || 1);
  const action = String(payload.action || "");

  if (action === "mint") {
    const built = buildIdentityMintOperation(payload);
    return {
      ok: true,
      ...built,
      signingMessages: {
        nostrProof: buildNostrProofMessage({ action: "mint", chainId, account: payload.account, sequence: seq }),
      },
    };
  }
  if (action === "update") {
    return { ok: true, ...buildIdentityUpdateOperation(payload) };
  }
  if (action === "link") {
    const built = buildIdentityLinkOperation(payload);
    const signingMessages = {};
    if (payload.kind === "validator_node") {
      signingMessages.validatorLink = buildValidatorLinkMessage({ chainId, account: payload.account, nodeId: payload.target, sequence: seq });
    } else if (payload.kind === "old_chain_account") {
      signingMessages.oldChainLink = buildOldChainLinkMessage({ chainId, account: payload.account, oldChainAccount: payload.target, sequence: seq });
    } else if (payload.kind === "agent_controller") {
      signingMessages.controllerLink = buildControllerLinkMessage({ chainId, account: payload.account, controllerAccount: payload.target, sequence: seq });
    }
    return { ok: true, ...built, signingMessages };
  }
  if (action === "unlink") {
    const built = buildIdentityUnlinkOperation(payload);
    return {
      ok: true,
      ...built,
      signingMessages: {
        selfUnlink: buildSelfUnlinkMessage({ chainId, account: payload.account, linkId: payload.linkId }),
      },
    };
  }
  if (action === "rotate") {
    const built = buildIdentityRotateOperation(payload);
    return {
      ok: true,
      ...built,
      signingMessages: {
        nostrProof: buildNostrProofMessage({ action: "rotate", chainId, account: payload.account, sequence: seq }),
      },
    };
  }
  if (action === "rotate_account") {
    const built = buildIdentityRotateAccountOperation(payload);
    return {
      ok: true,
      ...built,
      signingMessages: {
        destinationCosignature: buildRotateAccountMessage({
          chainId,
          oldAccount: payload.account,
          newAccount: payload.newAccount,
          identitySequence: seq,
        }),
      },
    };
  }
  if (action === "revoke") {
    return { ok: true, ...buildIdentityRevokeOperation(payload) };
  }
  return { ok: false, status: 400, error: "identity_invalid_action" };
}

export function createIdentityRouteHandler({
  registrar = defaultRegistrar(),
  store = defaultStore,
  getLegacyV1Identity = async (accountId) => getNostrIdentity({ accountId, viewerAccountId: accountId }).catch(() => null),
  fetchImpl = fetch,
  dnsTxtResolver = null,
} = {}) {
  return async function handleIdentityRoute({ json, readJson, req, res, session, url }) {
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/identity/")) return false;
    const accountId = String(session?.accountId || "").trim();

    if (pathname === "/api/identity/check-handle") {
      if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "identity_method_not_allowed" });
        return true;
      }
      const handle = url.searchParams.get("handle") || "";
      const identityKind = url.searchParams.get("kind") || "human";
      const result = await registrar.inspectHandle({ handle, accountId, identityKind });
      json(res, result.ok ? 200 : 400, result);
      return true;
    }

    if (!accountId) {
      json(res, 401, { ok: false, error: "identity_login_required", message: "Sign in before managing on-chain identity." });
      return true;
    }

    if (pathname === "/api/identity/status") {
      if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "identity_method_not_allowed" });
        return true;
      }
      const [legacyV1, onChain, reservations, customClaims] = await Promise.all([
        getLegacyV1Identity(accountId),
        store.getOnChainIdentityForAccount(accountId),
        store.listReservationsForAccount(accountId),
        store.listCustomNip05Claims(accountId),
      ]);
      json(res, 200, {
        ok: true,
        namespace: registrar.namespace,
        defaultRelays: DEFAULT_IDENTITY_RELAYS,
        fees: {
          mintStateExpansionAtoms: IDENTITY_MINT_STATE_EXPANSION_FEE,
          linkStateExpansionAtoms: IDENTITY_LINK_STATE_EXPANSION_FEE,
        },
        legacyV1: legacyV1
          ? {
            nostrPubkeyHex: legacyV1.nostrPubkeyHex,
            npub: legacyV1.npub,
            nip05: legacyV1.nip05,
            preferredRelays: legacyV1.preferredRelays || [],
            derivationVersion: 1,
          }
          : null,
        onChain: onChain || null,
        reservations,
        customClaims,
      });
      return true;
    }

    if (pathname === "/api/identity/reserve") {
      if (req.method !== "POST") {
        json(res, 405, { ok: false, error: "identity_method_not_allowed" });
        return true;
      }
      const payload = await readJson(req, 8192);
      const legacyV1 = await getLegacyV1Identity(accountId);
      const result = await registrar.reserveHandle({
        accountId,
        l1Account: payload.l1Account || "",
        handle: payload.handle || "",
        existingV1NostrPubkeyHex: legacyV1?.nostrPubkeyHex || "",
        requestedNostrPubkeyHex: payload.nostrPubkeyHex || "",
        optIntoV2: payload.optIntoV2 === true,
        identityKind: payload.identityKind || "human",
      });
      json(res, result.ok ? 200 : Number(result.status || 400), result);
      return true;
    }

    if (pathname === "/api/identity/attest") {
      if (req.method !== "POST") {
        json(res, 405, { ok: false, error: "identity_method_not_allowed" });
        return true;
      }
      const payload = await readJson(req, 8192);
      const result = await registrar.issueHotHandleAttestation({
        accountId,
        account: payload.account,
        handle: payload.handle,
        nostrPubkeyHex: payload.nostrPubkeyHex,
        reservationSaltHex: payload.reservationSaltHex,
        identityKind: payload.identityKind || "human",
        chainId: payload.chainId || "postfiat-wan-devnet-2",
        currentHeight: payload.currentHeight || 1,
      });
      json(res, result.ok ? 200 : Number(result.status || 400), result);
      return true;
    }

    if (pathname === "/api/identity/build-tx") {
      if (req.method !== "POST") {
        json(res, 405, { ok: false, error: "identity_method_not_allowed" });
        return true;
      }
      const payload = await readJson(req, 32_768);
      try {
        const built = buildIdentitySetPayloadResponse(payload);
        json(res, built.ok ? 200 : Number(built.status || 400), built);
      } catch (error) {
        json(res, Number(error?.status || 400), {
          ok: false,
          error: error?.code || "identity_build_tx_failed",
          message: error?.message || "Could not build identity_set payload.",
        });
      }
      return true;
    }

    if (pathname === "/api/identity/custom-nip05/verify") {
      if (req.method !== "POST") {
        json(res, 405, { ok: false, error: "identity_method_not_allowed" });
        return true;
      }
      const payload = await readJson(req, 4096);
      const result = await registrar.verifyAndBuildCustomNip05Link({
        accountId,
        account: payload.account || "",
        identifier: payload.identifier,
        nostrPubkeyHex: payload.nostrPubkeyHex,
        existingLinkCount: payload.existingLinkCount || 0,
        fetchImpl,
        dnsTxtResolver,
      });
      json(res, result.ok ? 200 : Number(result.status || 400), result);
      return true;
    }

    return false;
  };
}

export const handleIdentityRoute = createIdentityRouteHandler();
export { defaultStore as identityStore };
