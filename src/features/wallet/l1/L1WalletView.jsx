import { useEffect, useMemo, useRef, useState } from "react";
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
  const currentCheck = useRef(isAccountCurrent);
  currentCheck.current = isAccountCurrent;
  const core = useMemo(() => accountId ? new L1WalletCore(accountId, () => currentCheck.current?.() !== false) : null, [accountId]);
  const [address, setAddress] = useState(null);
  const [exists, setExists] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [seed, setSeed] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    core?.status().then(value => { if (active) setExists(Boolean(value)); }).catch(() => {});
    return () => { active = false; core?.dispose(); };
  }, [core]);
  useEffect(() => {
    if (!address) return undefined;
    const lock = () => { core.lock(); setAddress(null); setPassphrase(""); };
    let timer = setTimeout(lock, 15 * 60 * 1000);
    const activity = () => { clearTimeout(timer); timer = setTimeout(lock, 15 * 60 * 1000); };
    window.addEventListener("pagehide", lock);
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    return () => { clearTimeout(timer); window.removeEventListener("pagehide", lock); window.removeEventListener("pointerdown", activity); window.removeEventListener("keydown", activity); };
  }, [core, address]);
  async function openWallet(importSeed = false) {
    setBusy(true); setError("");
    try { setAddress(await (exists ? core.unlock(passphrase) : core.create(passphrase, importSeed ? seed.trim().toLowerCase() : null))); setExists(true); setPassphrase(""); setSeed(""); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  async function restoreBackup(event) {
    const file = event.target.files?.[0]; if (!file) return;
    setBusy(true); setError("");
    try {
      if (file.size > 65536) throw new Error("Backup file is too large");
      setAddress(await core.importBackup(JSON.parse(await file.text()), passphrase));
      setExists(true); setPassphrase(""); setSeed("");
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); event.target.value = ""; }
  }
  async function downloadBackup() {
    try {
      const data = await core.exportBackup();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `l1-${data.metadata.address}-encrypted.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { setError(failure.message); }
  }
  const client = useMemo(() => ({ accountId, address, unlocked: Boolean(address), chainId: "devnet-2", getBalances: unavailable, quote: unavailable, sign: unavailable, submit: unavailable, call: (method, params) => core.call(method, params), subscribe: unavailable }), [accountId, address, core]);
  if (!accountId) return <section><h1>L1 wallet</h1><p>Sign in to open your L1 wallet.</p></section>;
  const Tab = tabs[tab];
  return <L1WalletContext.Provider value={client}><section style={{ padding: 24 }}>
    <h1>L1 wallet</h1><p>Post Fiat · devnet-2</p>
    <nav aria-label="L1 wallet tabs" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>{Object.keys(tabs).map(name => <button key={name} type="button" aria-pressed={tab === name} onClick={() => setTab(name)}>{name}</button>)}</nav>
    {error && <p role="alert">{error}</p>}
    {address ? <div><p data-testid="l1-address">{address}</p><button type="button" onClick={() => { core.lock(); setAddress(null); }}>Lock L1 wallet</button><button type="button" onClick={downloadBackup}>Download encrypted backup</button><p>Save your encrypted backup and passphrase before funding this wallet.</p></div> : <div><label>Wallet passphrase<input aria-label="Wallet passphrase" type="password" autoComplete="current-password" value={passphrase} onChange={e => setPassphrase(e.target.value)} /></label><button type="button" disabled={busy} onClick={() => openWallet(false)}>{exists ? "Unlock L1 wallet" : "Create L1 wallet"}</button>{!exists && <div>
      <label>Recovery seed<input aria-label="Recovery seed" type="password" autoComplete="off" value={seed} onChange={e => setSeed(e.target.value)} /></label>
      <button type="button" disabled={busy || !seed} onClick={() => openWallet(true)}>Import recovery seed</button>
      <label>Encrypted backup<input aria-label="Encrypted backup" type="file" accept=".json,application/json" disabled={busy || !passphrase} onChange={restoreBackup} /></label>
      <p>Enter the backup passphrase above before selecting its file.</p>
    </div>}</div>}
    <h2>{tab}</h2>{Tab ? <Tab client={client} /> : <p>{tab === "Home" ? "Create or unlock your browser wallet to begin." : `${tab} will be available after unlocking.`}</p>}
  </section></L1WalletContext.Provider>;
}
