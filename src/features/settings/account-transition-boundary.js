export function initialAccountBoundary(accountId = "") {
  return {
    accountId: String(accountId || "").trim(),
    generation: 0,
    transitioning: false,
  };
}

export function beginAccountBoundaryTransition(boundary = initialAccountBoundary()) {
  return {
    ...boundary,
    generation: Number(boundary.generation || 0) + 1,
    transitioning: true,
  };
}

export function cancelAccountBoundaryTransition(boundary = initialAccountBoundary()) {
  return {
    ...boundary,
    generation: Number(boundary.generation || 0) + 1,
    transitioning: false,
  };
}

export function accountBoundaryCaptureIsCurrent(boundary, capture) {
  return Boolean(
    boundary
    && capture
    && !boundary.transitioning
    && boundary.accountId === capture.accountId
    && boundary.generation === capture.generation
  );
}

export function acceptAccountBoundaryResponse(boundary, capture, responseAccountId = "") {
  if (!accountBoundaryCaptureIsCurrent(boundary, capture)) {
    return { ok: false, error: "account_switch_session_changed", boundary };
  }
  const responseId = String(responseAccountId || "").trim();
  if (boundary.accountId && responseId !== boundary.accountId) {
    return { ok: false, error: "account_switch_session_changed", boundary };
  }
  return {
    ok: true,
    boundary: {
      accountId: responseId,
      generation: boundary.accountId === responseId
        ? boundary.generation
        : boundary.generation + 1,
      transitioning: false,
    },
  };
}
