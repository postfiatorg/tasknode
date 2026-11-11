import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { promptStats } from "../../../packages/tasknode-cli/lib/prompt-stats.mjs";

export function PromptStatsPanel({ events }) {
  const [days, setDays] = useState(7);
  const stats = promptStats(events, { days });
  return (
    <section className="prompt-activity" aria-label="Prompt statistics">
      <header className="prompt-section-heading">
        <h2>Prompt activity</h2>
        <div className="docs-view-tabs" aria-label="Activity period" role="group">
          {[7, 30].map((period) => (
            <button key={period} type="button" aria-pressed={days === period} onClick={() => setDays(period)}>
              Last {period} days
            </button>
          ))}
        </div>
      </header>
      <p className="prompt-activity-summary">
        <span>
          <strong>{stats.totals.created}</strong> prompts created
        </span>
        <span>
          <strong>{stats.totals.versions}</strong> versions saved
        </span>
        <span>
          <strong>{stats.totals.activeMinutes.toFixed(2)}</strong> active minutes
        </span>
      </p>
      <details className="prompt-daily-details">
        <summary>
          Daily breakdown <ChevronDown size={13} />
        </summary>
        <div className="prompt-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Date (UTC)</th>
                <th>Prompts created</th>
                <th>Versions saved</th>
                <th>Active minutes</th>
              </tr>
            </thead>
            <tbody>
              {stats.daily.map((row) => (
                <tr key={row.day}>
                  <td>{row.day}</td>
                  <td>{row.created}</td>
                  <td>{row.versions}</td>
                  <td>{row.activeMinutes.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
