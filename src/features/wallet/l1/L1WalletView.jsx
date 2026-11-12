import { useEffect, useMemo, useState } from "react";
import Bridge from "./bridge/index.jsx";
import Market from "./market/index.jsx";
import Issuer from "./issuer/index.jsx";
import Redeem from "./redeem/index.jsx";
import { L1WalletContext } from "./client.jsx";
import { L1WalletCore } from "./core.js";
const tabs = { Home: null, Send: null, Activity: null, Bridge, Market, Issuer, Redeem };
const unavailable = async () => { throw new Error("Unlock an L1 wallet first"); };
export default function L1WalletView({ accountId, isAccountCurrent }) {
  const [tab, setTab] = useState("Home");
  const core = useMemo(() => accountId ? new L1WalletCore(accountId, isAccountCurrent) : null, [accountId, isAccountCurrent]);
  const [address, setAddress] = useState(null);
  const [exists, setExists] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    core?.status().then(value => { if (active) setExists(Boolean(value)); }).catch(() => {});
    return () => { active = false; core?.dispose(); };
  }, [core]);
  async function openWallet() {
    setBusy(true); setError("");
    try { setAddress(await (exists ? core.unlock(passphrase) : core.create(passphrase))); setExists(true); setPassphrase(""); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  if (!accountId) return <section><h1>L1 wallet</h1><p>Sign in to open your L1 wallet.</p></section>;
  const Tab = tabs[tab];
  const client = { accountId, address, unlocked: Boolean(address), chainId: "devnet-2", getBalances: unavailable, quote: unavailable, sign: unavailable, submit: unavailable, call: unavailable, subscribe: unavailable };
  return <L1WalletContext.Provider value={client}><section style={{ padding: 24 }}>
    <h1>L1 wallet</h1><p>Post Fiat · devnet-2</p>
    <nav aria-label="L1 wallet tabs" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>{Object.keys(tabs).map(name => <button key={name} type="button" aria-pressed={tab === name} onClick={() => setTab(name)}>{name}</button>)}</nav>
    {error && <p role="alert">{error}</p>}
    {address ? <div><p data-testid="l1-address">{address}</p><button type="button" onClick={() => { core.lock(); setAddress(null); }}>Lock L1 wallet</button></div> : <div><label>Wallet passphrase<input aria-label="Wallet passphrase" type="password" autoComplete="current-password" value={passphrase} onChange={e => setPassphrase(e.target.value)} /></label><button type="button" disabled={busy} onClick={openWallet}>{exists ? "Unlock L1 wallet" : "Create L1 wallet"}</button></div>}
    <h2>{tab}</h2>{Tab ? <Tab client={client} /> : <p>{tab === "Home" ? "Create or unlock your browser wallet to begin." : `${tab} will be available after unlocking.`}</p>}
  </section></L1WalletContext.Provider>;
}
