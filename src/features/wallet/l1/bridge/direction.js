// Which half of the bridge page opens next: the Home buttons set it, the page reads it once.
const KEY = "l1.bridge.direction";
export function openBridge(direction) {
  try { sessionStorage.setItem(KEY, direction === "withdraw" ? "withdraw" : "deposit"); } catch { /* opens on deposits */ }
}
export function takeBridgeDirection() {
  try {
    const value = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return value === "withdraw" ? "withdraw" : "deposit";
  } catch { return "deposit"; }
}
