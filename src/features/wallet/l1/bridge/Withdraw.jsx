import { lazy, Suspense, useEffect, useState } from "react";
import { Card } from "../ui.jsx";
import EthereumWithdraw from "./EthereumWithdraw.jsx";
import { savedBurn, solanaOffered, trackingKey } from "./solana-offer.js";

const SolanaWithdraw = lazy(() => import("./SolanaWithdraw.jsx"));

export default function Withdraw({ client }) {
  const key = trackingKey(client);
  const [destination, choose] = useState(() => savedBurn(key) ? "Solana" : "Ethereum");
  const [visitedSolana, setVisitedSolana] = useState(destination === "Solana");
  // A saved burn keeps the Solana screen reachable so its payout can still be tracked.
  const [offered, setOffered] = useState(destination === "Solana");
  useEffect(() => {
    let active = true;
    void solanaOffered().then(on => { if (active && on) setOffered(true); });
    return () => { active = false; };
  }, []);
  return <>
    {offered && <Card as="div" className="l1-view l1-source">
      <span className="l1-eyebrow">Withdraw USDC to</span>
      <div className="l1-seg" role="radiogroup" aria-label="Withdrawal destination">
        {["Ethereum", "Solana"].map(chain => <label key={chain}>
          <input type="radio" name="withdraw-destination" aria-label={`Withdraw to ${chain}`} checked={destination === chain}
            onChange={() => { choose(chain); if (chain === "Solana") setVisitedSolana(true); }} />
          <span>{chain}</span>
        </label>)}
      </div>
    </Card>}
    <div className="l1-source-pane" hidden={destination !== "Ethereum"}><EthereumWithdraw client={client} /></div>
    {offered && visitedSolana && <div className="l1-source-pane" hidden={destination !== "Solana"}><Suspense fallback={<p role="status">Checking availability…</p>}><SolanaWithdraw client={client} storageKey={key} /></Suspense></div>}
  </>;
}
