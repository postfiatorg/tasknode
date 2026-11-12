// Pure grouping of account lines for the portfolio view (display only).
const big = value => (value === null || value === undefined ? null : BigInt(value));

// Group raw account lines into the three assets this wallet is about, using the
// published B23 configuration when it is available and asset codes otherwise.
export function classifyLines(lines, config) {
  const out = { b23: null, pfusdc: null, pfusdcFamily: null, pfusdcBridged: 0n, others: [], matched: Boolean(config) };
  for (const line of lines) {
    const balance = big(line.balance ?? line.balance_atoms ?? 0) ?? 0n;
    const code = line.code || line.asset_code || line.currency;
    const id = line.asset_id;
    if (config && id === config.b23_asset_id) { out.b23 = (out.b23 ?? 0n) + balance; continue; }
    if (config && (id === config.pfusdc_asset_id || id === config.market_quote_asset_id || line.asset_family_id === config.pfusdc_asset_id || config.pfusdc_source_asset_ids?.includes(id))) {
      out.pfusdc = (out.pfusdc ?? 0n) + balance;
      if (id === config.pfusdc_asset_id) out.pfusdcFamily = (out.pfusdcFamily ?? 0n) + balance; else out.pfusdcBridged += balance;
      continue;
    }
    if (!config && code === 'B23') { out.b23 = (out.b23 ?? 0n) + balance; continue; }
    if (!config && code === 'PFUSDC') { out.pfusdc = (out.pfusdc ?? 0n) + balance; continue; }
    out.others.push({ code: code || null, id, balance, precision: Number.isSafeInteger(line.precision) ? line.precision : 6 });
  }
  return out;
}
