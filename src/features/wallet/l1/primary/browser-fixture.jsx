import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Market from '../market/index.jsx';
import SubscriberRedeem from './SubscriberRedeem.jsx';
import { config, fixture } from './fixtures.js';
import '../l1-wallet.css';
const f = fixture();
if (new URLSearchParams(location.search).has('uncertain')) f.client.uncertain = true;
function App() {
  const [view, setView] = useState('market'), [key, setKey] = useState(0);
  window.primaryFixture = { ...f, view: setView, remount: () => setKey(k => k + 1) };
  return <div className="l1w">{view === 'market' ? <Market key={key} client={f.client} marketConfig={config} onNavigate={setView} /> : <SubscriberRedeem client={f.client} data={{ config, state: f.state, balances: f.state.balances }} refresh={() => setKey(k => k + 1)} onNavigate={() => setView('market')} />}</div>;
}
createRoot(document.getElementById('root')).render(React.createElement(App));
