import { useSyncExternalStore } from "react";
// The same store initializes the document before paint; no second resolver.
import "../../public/theme-init.js";

export function useAppearance() {
  const store = window.tasknodeAppearance;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { ...snapshot, setPreference: store.setPreference };
}
