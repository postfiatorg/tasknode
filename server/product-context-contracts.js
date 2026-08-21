import { getLinkedWallet } from "./repositories/account-wallets.js";
import { getContextHistory, saveContextDocument } from "./repositories/context.js";
import { fetchContextIpfsJson, normalizeContextCid } from "./context-ipfs.js";

function hasAll(keys) {
  return keys.every((key) => Boolean(process.env[key]));
}

function actionResponse({ status, error, action, message, actionRequired }) {
  return {
    status,
    body: {
      ok: false,
      error,
      action,
      message,
      actionRequired,
    },
  };
}

function contextAction({ id, label, path, method = "POST", requiredEnv = [], enabled = false, status, note, actionRequired }) {
  const configured = hasAll(requiredEnv);

  return {
    id,
    label,
    path,
    method,
    configured,
    enabled: configured && enabled,
    status: status || (configured ? (enabled ? "ready" : "disabled") : "missing_config"),
    actionRequired: configured ? actionRequired : `Configure ${requiredEnv.join(", ")}`,
    note,
  };
}


export function contextActions() {
  return [
    contextAction({
      id: "import_shared_url",
      label: "Import shared URL",
      path: "/api/context/import/start",
      requiredEnv: ["IPFS_API_URL"],
      note:
        "Imports Google Docs, Notion, Gist, or other shared document URLs into a cacheable context record.",
      actionRequired:
        "Implement URL evidence checks, document fetch adapters, cache storage, and user confirmation before enabling context import.",
    }),
    contextAction({
      id: "save_edit",
      label: "Save context edit",
      path: "/api/context/edit/save",
      enabled: true,
      note:
        "Saves native context edits without inking a PFTL transaction by default.",
      actionRequired:
        "Sign in with an account, edit the native context document, and save it without wallet unlock.",
    }),
    contextAction({
      id: "fetch_history_cid",
      label: "Fetch historical CID",
      path: "/api/context/history/ipfs/:cid",
      method: "GET",
      enabled: true,
      note:
        "Fetches encrypted JSON only for CIDs already present in the signed-in account's cached PFTL context projection.",
      actionRequired:
        "Unlock the local seed vault in the browser before decrypting fetched CID content.",
    }),
    contextAction({
      id: "ink_manifest",
      label: "Ink PFTL manifest",
      path: "/api/context/manifest/ink",
      enabled: true,
      note:
        "Encrypts the native context document, pins it to IPFS, and signs a portable pf.ptr/v4 CONTEXT pointer from the unlocked wallet.",
      actionRequired:
        "Unlock the local seed vault in the browser. The seed never leaves the device; the server only receives the encrypted payload and signed transaction blob.",
    }),
  ];
}


export function contextActionByPath(pathname) {
  return contextActions().find((action) => action.path === pathname) || null;
}

export function contextActionStart(pathname, method) {
  const action = contextActionByPath(pathname);

  if (!action) {
    return actionResponse({
      status: 404,
      error: "unknown_context_action",
      action: pathname,
      message: "Unknown context action.",
    });
  }

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "context_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Call the context action with the declared method.",
    });
  }

  if (!action.configured) {
    return actionResponse({
      status: 409,
      error: "context_action_not_configured",
      action: action.id,
      message: `${action.label} is not configured for this environment.`,
      actionRequired: action.actionRequired,
    });
  }

  return actionResponse({
    status: 503,
    error: "context_action_disabled",
    action: action.id,
    message: `${action.label} is configured but disabled until its trust boundary is implemented.`,
    actionRequired: action.actionRequired,
  });
}

export async function contextEditSave(payload, method, session = null) {
  const action = contextActionByPath("/api/context/edit/save");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "context_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Save context edits with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "context_login_required",
      action: action.id,
      message: "Sign in before saving context.",
      actionRequired: "Use an account login, then save the native context document.",
    });
  }

  const result = await saveContextDocument({
    accountId: session.accountId,
    title: payload?.title,
    body: payload?.body,
  });

  if (!result.ok) {
    return actionResponse({
      status: result.status || 400,
      error: result.error || "context_save_failed",
      action: action.id,
      message: "Context could not be saved.",
      actionRequired: "Check the context payload and try again.",
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      action: action.id,
      message: "Context saved.",
      document: result.document,
    },
  };
}

function contextHistoryCids(history) {
  const cids = new Set();
  const add = (value) => {
    const cid = normalizeContextCid(value);
    if (cid) cids.add(cid);
  };

  add(history?.latestContextPointer?.cid);
  for (const pointer of Array.isArray(history?.contextUpdates) ? history.contextUpdates : []) {
    add(pointer?.cid);
  }
  for (const pointer of Array.isArray(history?.taskEvents) ? history.taskEvents : []) {
    add(pointer?.cid);
  }
  return cids;
}

export async function contextHistoryIpfsFetch({ cid } = {}, method, session = null) {
  const action = contextActionByPath("/api/context/history/ipfs/:cid");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "context_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Fetch historical CIDs with GET.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "context_login_required",
      action: action.id,
      message: "Sign in before fetching historical context.",
      actionRequired: "Use an account login, then fetch cached context history CIDs.",
    });
  }

  const normalizedCid = normalizeContextCid(cid);
  const wallet = await getLinkedWallet({ accountId: session.accountId });
  if (wallet.status !== "linked" || !wallet.address) {
    return actionResponse({
      status: 409,
      error: "context_wallet_required",
      action: action.id,
      message: "Link the wallet that owns this historical context before fetching the CID.",
      actionRequired:
        "Relink and unlock the wallet that owns the cached context pointer, then load the preview again.",
    });
  }

  const history = await getContextHistory({ accountId: session.accountId, walletAddress: wallet.address });
  if (!contextHistoryCids(history).has(normalizedCid)) {
    return actionResponse({
      status: 404,
      error: "context_cid_not_cached",
      action: action.id,
      message: "CID is not part of this account's cached context history.",
      actionRequired: "Wait for the PFTL cache reducer to project the wallet pointer, then refresh history.",
    });
  }

  const result = await fetchContextIpfsJson({ cid: normalizedCid });
  if (!result.ok) {
    return actionResponse({
      status: result.status || 502,
      error: result.error || "context_ipfs_fetch_failed",
      action: action.id,
      message: result.message || "Context CID could not be fetched.",
      actionRequired: "Check the CID gateway configuration and try again.",
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      action: action.id,
      cid: result.cid,
      gateway: result.gateway,
      payload: result.payload,
    },
  };
}
