export function ResearchPreview({ review, explicitBudget, onBudgetChange }) {
  const { preview, budget, loading, error } = review;
  return <div className="research-preview">
    <p>{loading ? "Choosing a research approach…" : preview
      ? `${preview.mode === "agent" ? "Exploratory research" : "Fast research"} · ${preview.mode === "agent" ? "up to 10 minutes" : "about 3 minutes"}`
      : "Preview your research approach and maximum before starting. The preview is free."}</p>
    {preview && <p className="research-preview-reason">{preview.reason}</p>}
    <label className="deep-research-budget">Maximum USD
      <input aria-label="Research maximum cost (USD)" type="number" min="0.05" max="10" step="0.000001"
        value={explicitBudget ?? (preview ? budget : "")} placeholder="Preview first"
        onChange={event => onBudgetChange(event.target.value)} />
    </label>
    {preview && <p>Start research with a maximum of ${Number.isFinite(budget) ? budget.toFixed(6).replaceAll(".000000", "") : "—"}. You pay the actual cost.</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
