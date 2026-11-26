import { useEffect, useRef } from "react";

// /activate and /connect send signed-out browsers to #activate/<code> or
// #connect (with /switch to sign in as a different account). The target
// survives the login reload in sessionStorage and resumes once signed in.
const STORAGE_KEY = "tasknode.pendingAgentLink";
const MAX_AGE_MS = 10 * 60_000;

export function pendingAgentLinkFromLocation() {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#\/?/, "");
  const match = hash.match(/^(activate|connect)(?:\/([A-Za-z0-9-]{4,12}))?(\/switch)?$/i);
  if (!match) return null;
  const code = match[2] && match[1].toLowerCase() === "activate" ? match[2].toUpperCase() : "";
  const target = match[1].toLowerCase() === "activate" ? `/activate${code ? `?code=${encodeURIComponent(code)}` : ""}` : "/connect";
  const link = { target, switchAccount: Boolean(match[3]), at: Date.now() };
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(link));
  } catch {
    // Storage blocked: the link still resumes in this page load.
  }
  return link;
}

function storedLink() {
  try {
    const link = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || "null");
    return link && Date.now() - Number(link.at) < MAX_AGE_MS ? link : null;
  } catch {
    return null;
  }
}

export function usePendingAgentLink({ initialLink, loading, signedIn, onLogin, onSwitchAccount }) {
  const callbacks = useRef({ onLogin, onSwitchAccount });
  callbacks.current = { onLogin, onSwitchAccount };
  const switchHandled = useRef(false);
  // Runs when the session state settles or changes, not on every render, so a
  // dismissed login dialog stays dismissed.
  useEffect(() => {
    if (loading) return;
    const link = storedLink() || initialLink;
    if (!link) return;
    if (signedIn && initialLink?.switchAccount && !switchHandled.current) {
      switchHandled.current = true;
      callbacks.current.onSwitchAccount?.();
      return;
    }
    if (signedIn) {
      try {
        window.sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        // Ignore blocked storage.
      }
      window.location.assign(link.target);
      return;
    }
    callbacks.current.onLogin?.();
  }, [initialLink, loading, signedIn]);
}
