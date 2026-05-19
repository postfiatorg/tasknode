import {
  applyContextEditProposal,
  rejectContextEditProposal,
} from "./context-edit-chat.js";

function body(status, payload = {}) {
  return {
    status,
    body: {
      ok: status >= 200 && status < 300,
      ...payload,
    },
  };
}

export async function contextEditProposalAction({ action = "", method = "POST", proposalId = "", session = null } = {}) {
  if (method !== "POST") {
    return body(405, {
      error: "context_edit_method_not_allowed",
      message: "Context edit proposal actions require POST.",
    });
  }
  if (!session?.accountId) {
    return body(401, {
      error: "context_login_required",
      message: "Sign in before applying context edits.",
    });
  }
  if (action !== "apply" && action !== "reject") {
    return body(404, {
      error: "context_edit_action_not_found",
      message: "Unknown context edit proposal action.",
    });
  }

  try {
    const result = action === "reject"
      ? await rejectContextEditProposal({ accountId: session.accountId, proposalId })
      : await applyContextEditProposal({ accountId: session.accountId, proposalId });
    return body(200, {
      action: action === "reject" ? "context_edit_reject" : "context_edit_apply",
      message: action === "reject" ? "Context edit rejected." : "Context updated.",
      ...result,
    });
  } catch (error) {
    const status = error?.status || 500;
    return body(status, {
      error: error?.message || "context_edit_action_failed",
      message: error?.userMessage || "Context edit action failed.",
      actionRequired: status === 409
        ? "Regenerate the edit against the latest context document."
        : "Retry the action or reload the current context document.",
    });
  }
}
