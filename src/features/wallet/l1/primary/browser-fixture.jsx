import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Market from '../market/index.jsx';
import SubscriberRedeem from './SubscriberRedeem.jsx';
import { config, fixture } from './fixtures.js';
import { useGallery } from '../gallery/useGallery.js';
import '../l1-wallet.css';
const f = fixture();
const flags = { failRegistry: false, failDuringSubmit: false };
let refreshRegistry = () => {};
window.fetch = async () => flags.failRegistry ? Response.json({ error: 'synthetic registry outage' }, { status: 503 }) : Response.json({ coins: [{ ...config, asset_id: config.nav_asset_id, name: config.symbol }] });
const submit = f.client.submit;
f.client.submit = async intent => {
  const result = await submit(intent);
  if (flags.failDuringSubmit) {
    flags.failDuringSubmit = false; flags.failRegistry = true; refreshRegistry();
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return result;
};
if (new URLSearchParams(location.search).has('uncertain')) f.client.uncertain = true;
function App() {
  const gallery = useGallery(f.client);
  refreshRegistry = gallery.refresh;
  const [, setTick] = useState(0);
  useEffect(() => { const timer = setInterval(() => setTick(n => n + 1), 200); return () => clearInterval(timer); }, []);
  const [view, setView] = useState('market'), [key, setKey] = useState(0);
  window.primaryFixture = { ...f, view: setView, remount: () => setKey(k => k + 1), failDuringSubmit: () => { flags.failDuringSubmit = true; }, failRegistry: () => { flags.failRegistry = true; gallery.refresh(); }, recoverRegistry: () => { flags.failRegistry = false; gallery.refresh(); }, switchAccount: () => { f.client.accountId = 'other'; setTick(n => n + 1); } };
  const selected = gallery.coins?.find(c => c.asset_id === config.nav_asset_id);
  return <div className="l1w">{gallery.error && <p role="alert">Registry refresh unavailable</p>}{!selected ? <p>Choose a NAVCoin</p> : view === 'market' ? <Market key={key} client={f.client} marketConfig={{ ...selected }} onNavigate={setView} /> : <SubscriberRedeem client={f.client} data={{ config, state: f.state, balances: f.state.balances }} refresh={() => setKey(k => k + 1)} onNavigate={() => setView('market')} />}</div>;
}
createRoot(document.getElementById('root')).render(React.createElement(App));
