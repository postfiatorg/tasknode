export function isSignedInSession(session) {
  return session?.status === "signed_in" && Boolean(session?.accountId);
}
