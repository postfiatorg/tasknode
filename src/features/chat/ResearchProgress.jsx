export function ResearchProgress({ research }) {
  const progress = research.progress || {};
  const elapsed = Number(progress.elapsed_seconds);
  const cost = Number(progress.cost_usd);
  const active = !["completed", "failed", "cancelled"].includes(research.status);
  if (progress.sequence === undefined) return null;
  return <div className="research-progress" aria-live="polite">
    <p>{String(progress.stage || research.stage || "Researching").replaceAll("_", " ")}
      {Number.isFinite(elapsed) && ` · ${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s`}
      {Number.isFinite(cost) && ` · $${cost.toFixed(6)} spent`}</p>
    <p>Step {progress.step} of {progress.step_limit}
      {progress.documents_total > 0 && ` · ${progress.documents_completed} of ${progress.documents_total} documents processed`}</p>
    {active && <p>You can leave and return to this conversation. Your research continues in the background.</p>}
    {active && elapsed >= 900 && <p>This job is taking longer than expected. We will keep checking this same job.</p>}
  </div>;
}

export function ResearchTables({ tables = [] }) {
  if (!tables.length) return null;
  return <details className="research-data-tables"><summary>Research data tables ({tables.length})</summary>
    {tables.map((table, index) => <section key={index}><h3>{table.name}</h3>
      <div className="assistant-table-wrap" role="region" aria-label={table.name} tabIndex={0}>
        <table className="assistant-table"><thead><tr>{table.columns.map((column, i) =>
          <th key={i} scope="col">{column.name}{column.unit && ` (${column.unit})`}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, i) => <tr key={i}>{table.columns.map((column, j) =>
            <td key={j}>{row[column.name] ?? "—"}</td>)}</tr>)}</tbody></table>
      </div>
      {table.totalRows > table.rows.length && <p>Showing {table.rows.length} of {table.totalRows} supplied rows.</p>}
      {table.source_ids.length > 0 && <p>Sources: {table.source_ids.join(", ")}</p>}
    </section>)}
  </details>;
}
