import { useState } from "react";
import Bridge from "./bridge/index.jsx";
import Market from "./market/index.jsx";
import Issuer from "./issuer/index.jsx";
import Redeem from "./redeem/index.jsx";
import { L1WalletContext } from "./client.jsx";
const tabs = { Home: null, Send: null, Activity: null, Bridge, Market, Issuer, Redeem };
const unavailable = async () => { throw new Error("Unlock an L1 wallet first"); };
export default function L1WalletView({ accountId }) {
  const [tab, setTab] = useState("Home");
  if (!accountId) return <section><h1>L1 wallet</h1><p>Sign in to open your L1 wallet.</p></section>;
  const Tab = tabs[tab];
  const client = { accountId, address: null, unlocked: false, chainId: "devnet-2", getBalances: unavailable, quote: unavailable, sign: unavailable, submit: unavailable, call: unavailable, subscribe: unavailable };
  return <L1WalletContext.Provider value={client}><section style={{ padding: 24 }}>
    <h1>L1 wallet</h1><p>Post Fiat · devnet-2</p>
    <nav aria-label="L1 wallet tabs" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>{Object.keys(tabs).map(name => <button key={name} type="button" aria-pressed={tab === name} onClick={() => setTab(name)}>{name}</button>)}</nav>
    <h2>{tab}</h2>{Tab ? <Tab client={client} /> : <p>{tab === "Home" ? "Create or unlock your browser wallet to begin." : `${tab} will be available after unlocking.`}</p>}
  </section></L1WalletContext.Provider>;
}
