import { requestJson } from "../../api";

export const CONTEXT_EDIT_MODE = "context_edit";
export const CONTEXT_EDIT_PLACEHOLDER = "Describe the context edit you want";

export async function applyContextEditProposal(proposalId) {
  return requestJson(`/api/context/edit/proposals/${encodeURIComponent(proposalId)}/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export async function rejectContextEditProposal(proposalId) {
  return requestJson(`/api/context/edit/proposals/${encodeURIComponent(proposalId)}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export function patchContextEditProposalTurn(turns, proposalId, patch = {}) {
  return turns.map((turn) => {
    const proposal = turn.metadata?.contextEdit?.proposal;
    if (!proposal || proposal.id !== proposalId) return turn;
    return {
      ...turn,
      metadata: {
        ...turn.metadata,
        contextEdit: {
          ...turn.metadata.contextEdit,
          proposal: {
            ...proposal,
            ...patch,
          },
        },
      },
    };
  });
}
