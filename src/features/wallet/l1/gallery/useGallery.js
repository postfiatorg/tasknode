import { useCallback, useEffect, useRef, useState } from "react";
import { loadRegistry, readCoin, sortByTvl } from "./model.js";

export function useGallery(client) {
  const [state, setState] = useState({ coins: null, error: "", loading: true });
  const [revision, setRevision] = useState(0);
  const clientRef = useRef(client); clientRef.current = client;
  const accountId = client?.accountId, address = client?.address, unlocked = client?.unlocked;
  useEffect(() => {
    let active = true, timer;
    if (!unlocked || !address) return undefined;
    const current = clientRef.current;
    async function update() {
      try {
        const registry = await loadRegistry();
        const coins = await Promise.all(registry.map(async coin => {
          try { return await readCoin(current, coin); }
          catch (error) { return { ...coin, errors: [error.message], history: [], latest: null }; }
        }));
        if (active) setState({ coins: sortByTvl(coins), error: "", loading: false, readAt: Date.now(), address, accountId });
      } catch (error) {
        if (active) setState({ coins: null, error: error.message, loading: false, address, accountId });
      } finally { if (active) timer = setTimeout(update, 15000); }
    }
    setState(previous => ({ ...previous, loading: true }));
    void update();
    return () => { active = false; clearTimeout(timer); };
  }, [accountId, address, unlocked, revision]);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  return { ...state, coins: unlocked && state.address === address && state.accountId === accountId ? state.coins : null, refresh };
}
