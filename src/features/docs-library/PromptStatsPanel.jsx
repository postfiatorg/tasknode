import { useState } from 'react';
import { promptStats } from '../../../packages/tasknode-cli/lib/prompt-stats.mjs';
export function PromptStatsPanel({ events, decrypted }) {
  const [days, setDays] = useState(7);
  const [documentId, setDocumentId] = useState('');
  const stats = promptStats(events, { days });
  return <section className="prompt-stats" aria-label="Prompt statistics">
    <h2>Prompt activity</h2>
    <label>Period <select value={days} onChange={event => setDays(Number(event.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option></select></label>
    <p>{stats.totals.created} prompts created · {stats.totals.versions} versions saved · {stats.totals.activeMinutes.toFixed(1)} active minutes</p>
    <table><thead><tr><th>Date (UTC)</th><th>Prompts created</th><th>Versions saved</th><th>Active minutes</th></tr></thead><tbody>{stats.daily.map(row => <tr key={row.day}><td>{row.day}</td><td>{row.created}</td><td>{row.versions}</td><td>{row.activeMinutes.toFixed(1)}</td></tr>)}</tbody></table>
    <label>Prompt timeline <select value={documentId} onChange={event => setDocumentId(event.target.value)}><option value="">Choose a prompt</option>{Object.entries(decrypted).filter(([, metadata]) => metadata.documentType === 'prompt').map(([id, metadata]) => <option key={id} value={id}>{metadata.title}</option>)}</select></label>
    {documentId && <ol>{events.filter(event => event.documentId === documentId).map(event => <li key={event.eventId}><time>{event.at}</time> · {event.kind.replaceAll('_', ' ')}{event.kind === 'version_saved' && <details><summary>Saved text</summary><pre>{event.text}</pre></details>}{event.kind === 'edit_session' && ` · ${event.activeSeconds} active seconds`}{event.kind === 'tih_run' && ` · ${event.before} → ${event.after}`}</li>)}</ol>}
  </section>;
}
