import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ChartCandlestick, Download, Ellipsis, FileKey, HandCoins, History, House, KeyRound, Landmark, Lock, Send as SendIcon, ShieldCheck, Wallet } from "lucide-react";
// Secondary views load on first use so the wallet shell stays small.
const Bridge = lazy(() => import("./bridge/index.jsx"));
const Market = lazy(() => import("./market/index.jsx"));
const Issuer = lazy(() => import("./issuer/index.jsx"));
const Redeem = lazy(() => import("./redeem/index.jsx"));
import { L1WalletContext } from "./client.jsx";
import { L1WalletCore } from "./core.js";
import WalletHome from "./WalletHome.jsx";
import Send from "./Send.jsx";
import Activity from "./Activity.jsx";
import { Badge, Card, IdChip, Notice, Spinner, ViewHeader } from "./ui.jsx";
// View ids stay the original tab names; onNavigate("bridge" | "Market" | ...) keeps working.
const tabs = { Home: WalletHome, Send, Activity, Bridge, Market, Issuer, Redeem };
const VIEWS = [
  { id: "Home", label: "Home", icon: House },
  { id: "Bridge", label: "Add funds", icon: ArrowDownToLine, title: "Add funds", subtitle: "Bring USDC over from Ethereum. It arrives in this wallet as PFUSDC, one for one." },
  { id: "Market", label: "Market", icon: ChartCandlestick, title: "Market", subtitle: "Buy B23 with PFUSDC from sellers on the Post Fiat order book." },
  { id: "Redeem", label: "Cash in", icon: HandCoins, title: "Cash in at NAV", subtitle: "Turn B23 into PFUSDC at net asset value, paid from the standing reserve." },
  { id: "Send", label: "Send", icon: SendIcon, title: "Send", subtitle: "Send PFT to another Post Fiat address." },
  { id: "Activity", label: "Activity", icon: History, title: "Activity", subtitle: "Transactions signed by this wallet and payments it received." },
];
const ISSUER = { id: "Issuer", label: "Issuer desk", icon: Landmark, title: "Issuer desk", subtitle: "Operator controls for the B23 issuer: mint at NAV, fund the cash-in reserve, post B23 for sale." };

function WalletMenu({ onBackup, onLock }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null), trigger = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    const escape = event => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div className="l1-menu" ref={root}>
    <button ref={trigger} type="button" className="l1-btn is-sm" aria-haspopup="true" aria-expanded={open} aria-label="Wallet menu" onClick={() => setOpen(value => !value)}><Ellipsis size={16} aria-hidden /></button>
    {open && <div className="l1-menu-pop">
      <button type="button" onClick={() => { setOpen(false); onBackup(); }}><Download size={16} aria-hidden />Download encrypted backup</button>
      <p className="l1-menu-note">The file is encrypted with your passphrase. Keep both; neither is stored by Task Node.</p>
      <hr />
      <button type="button" onClick={() => { setOpen(false); onLock(); }}><Lock size={16} aria-hidden />Lock L1 wallet</button>
    </div>}
  </div>;
}

function Gate({ exists, busy, passphrase, setPassphrase, seed, setSeed, openWallet, restoreBackup }) {
  return <>
    <Card className="l1-gate">
      <div className="l1-gate-art">
        <div>
          <div className="l1-eyebrow">Post Fiat L1</div>
          <h2>A wallet built for the quantum era.</h2>
          <p>Hold PFT, bring dollars over from Ethereum, and own B23: a NAVCoin priced at the net asset value of a Schwab brokerage account.</p>
        </div>
        <ul className="l1-gate-points">
          <li><ShieldCheck size={16} aria-hidden /><span>Every transaction is signed with ML-DSA, a post-quantum signature scheme.</span></li>
          <li><KeyRound size={16} aria-hidden /><span>Keys are created and encrypted in this browser. Task Node never sees them.</span></li>
          <li><Wallet size={16} aria-hidden /><span>Balances and receipts are read straight from the chain.</span></li>
        </ul>
      </div>
      <form className="l1-gate-form" onSubmit={event => { event.preventDefault(); if (!busy && passphrase) openWallet(false); }}>
        <div>
          <div className="l1-eyebrow">{exists ? "Welcome back" : "Get started"}</div>
          <h2 style={{ marginTop: 4 }}>{exists ? "Unlock your wallet" : "Create your wallet"}</h2>
        </div>
        <p>{exists ? "Enter the passphrase that encrypts this wallet on this device." : "Choose a passphrase. It encrypts your wallet on this device and protects your backup file."}</p>
        <label className="l1-field"><span>Wallet passphrase</span><input aria-label="Wallet passphrase" type="password" autoComplete={exists ? "current-password" : "new-password"} value={passphrase} onChange={e => setPassphrase(e.target.value)} /></label>
        <button type="button" className="l1-btn is-primary is-lg is-block" disabled={busy} onClick={() => openWallet(false)}>{exists ? "Unlock L1 wallet" : "Create L1 wallet"}</button>
        {!exists && <div className="l1-restore">
          <div className="l1-or">or restore</div>
          <div className="l1-restore-row">
            <label className="l1-field"><span>Recovery seed</span><input aria-label="Recovery seed" type="password" autoComplete="off" value={seed} onChange={e => setSeed(e.target.value)} /></label>
            <button type="button" className="l1-btn" style={{ minHeight: 46 }} disabled={busy || !seed} onClick={() => openWallet(true)}>Import recovery seed</button>
          </div>
          <label className="l1-file"><FileKey size={18} aria-hidden /><span>Encrypted backup<small>{passphrase ? "Choose the .json backup file to restore." : "Enter the backup passphrase above first."}</small></span><input aria-label="Encrypted backup" type="file" accept=".json,application/json" disabled={busy || !passphrase} onChange={restoreBackup} /></label>
        </div>}
      </form>
    </Card>
    <div className="l1-howto" aria-label="How it works">
      <div><span className="l1-step-num">1</span><span><b>Connect MetaMask</b><p>Link the Ethereum account that holds your USDC.</p></span></div>
      <div><span className="l1-step-num">2</span><span><b>Convert USDC to PFUSDC</b><p>Deposit on Ethereum; it is credited here once proven.</p></span></div>
      <div><span className="l1-step-num">3</span><span><b>Buy B23</b><p>Use PFUSDC on the order book. Cash in at NAV any time.</p></span></div>
    </div>
  </>;
}

export default function L1WalletView({ accountId, isAccountCurrent }) {
  const [tab, setTab] = useState("Home");
  const onNavigate = useCallback(tabId => {
    const name = Object.keys(tabs).find(candidate => candidate.toLowerCase() === String(tabId).toLowerCase());
    if (!name) return false;
    setTab(name);
    return true;
  }, []);
  const currentCheck = useRef(isAccountCurrent);
  currentCheck.current = isAccountCurrent;
  const core = useMemo(() => accountId ? new L1WalletCore(accountId, () => currentCheck.current?.() !== false) : null, [accountId]);
  const [address, setAddress] = useState(null);
  const [exists, setExists] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [seed, setSeed] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [backupDue, setBackupDue] = useState(false);
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
    const creating = !exists;
    try { setAddress(await (exists ? core.unlock(passphrase) : core.create(passphrase, importSeed ? seed.trim().toLowerCase() : null))); setExists(true); setPassphrase(""); setSeed(""); setBackupDue(creating); }
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
      setBackupDue(false);
    } catch (failure) { setError(failure.message); }
  }
  const client = useMemo(() => ({ accountId, address, unlocked: Boolean(address), chainId: "devnet-2", getBalances: () => core.getBalances(), quote: intent => core.quote(intent), sign: (intent, quote) => core.sign(intent, quote), submit: signed => core.submit(signed), call: (method, params) => core.call(method, params), subscribe: handler => core.subscribe(handler) }), [accountId, address, core]);
  if (!accountId) return <div className="route-scroll"><div className="l1w"><Card><ViewHeader eyebrow="Post Fiat L1" title="L1 wallet" subtitle="Sign in to open your L1 wallet." /></Card></div></div>;
  const Tab = tabs[tab];
  const view = tab === ISSUER.id ? ISSUER : VIEWS.find(item => item.id === tab);
  return <L1WalletContext.Provider value={client}><div className="route-scroll"><div className="l1w">
    <header className="l1-head">
      <div><div className="l1-eyebrow">Post Fiat · quantum-resistant L1</div><h1>L1 wallet</h1></div>
      {address && <div className="l1-head-side">
        <span className="l1-network" title="Post Fiat network"><span className="l1-dot" aria-hidden />{client.chainId}</span>
        <IdChip value={address} label="wallet address" testId="l1-address" />
        <WalletMenu onBackup={downloadBackup} onLock={() => { core.lock(); setAddress(null); }} />
      </div>}
    </header>
    {error && <div style={{ marginBottom: 16 }}><Notice tone="danger" role="alert">{error}</Notice></div>}
    {!address ? <Gate {...{ exists, busy, passphrase, setPassphrase, seed, setSeed, openWallet, restoreBackup }} /> : <>
      {backupDue && <div style={{ marginBottom: 18 }}><Notice tone="warning" title="Back up this wallet before adding funds" action={<button type="button" className="l1-btn is-sm" onClick={downloadBackup}><Download size={14} aria-hidden />Back up now</button>}>Download the encrypted backup and keep your passphrase somewhere safe. Without both, a lost browser means lost funds.</Notice></div>}
      <nav aria-label="L1 wallet tabs" className="l1-tabs">
        <div className="l1-tabs-main">{VIEWS.map(item => <button key={item.id} type="button" className="l1-tab" aria-pressed={tab === item.id} onClick={() => onNavigate(item.id)}><item.icon size={16} aria-hidden />{item.label}</button>)}</div>
        {/* Issuer actions live on the CLI; the consumer wallet does not link to the issuer desk. */}
      </nav>
      <div className="l1-enter" key={tab}>
        {view?.title && <ViewHeader eyebrow={view.id === ISSUER.id ? "Operator" : undefined} title={view.title} subtitle={view.subtitle}>{view.id === ISSUER.id && <Badge tone="warning">Issuer only</Badge>}</ViewHeader>}
        {Tab && <Suspense fallback={<p className="l1-status-line"><Spinner />Loading…</p>}><Tab client={client} onNavigate={onNavigate} /></Suspense>}
      </div>
    </>}
  </div></div></L1WalletContext.Provider>;
}
