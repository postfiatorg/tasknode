// Pure grouping of account lines for the portfolio view (display only).
const big = value => (value === null || value === undefined ? null : BigInt(value));

// Group raw account lines into the three assets this wallet is about, using the
// published active-asset configuration. Unconfigured NAV assets remain unclassified.
export function classifyLines(lines, registry) {
  const coins = Array.isArray(registry) ? registry : registry ? [registry] : [];
  const config = coins.length > 0;
  const out = { nav: null, pfusdc: null, pfusdcFamily: null, pfusdcBridged: 0n, others: [], matched: Boolean(config) };
  for (const line of lines) {
    const balance = big(line.balance ?? line.balance_atoms ?? 0) ?? 0n;
    const code = line.code || line.asset_code || line.currency;
    const id = line.asset_id;
    if (coins.some(c => id === (c.nav_asset_id || c.asset_id))) { out.nav = (out.nav ?? 0n) + balance; continue; }
    if (coins.some(c => id === c.pfusdc_asset_id || id === c.market_quote_asset_id || (c.pfusdc_asset_id && line.asset_family_id === c.pfusdc_asset_id) || c.pfusdc_source_asset_ids?.includes(id))) {
      out.pfusdc = (out.pfusdc ?? 0n) + balance;
      if (coins.some(c => id === c.pfusdc_asset_id)) out.pfusdcFamily = (out.pfusdcFamily ?? 0n) + balance; else out.pfusdcBridged += balance;
      continue;
    }
    if (!config && code === 'PFUSDC') { out.pfusdc = (out.pfusdc ?? 0n) + balance; continue; }
    out.others.push({ code: code || null, id, balance, precision: Number.isSafeInteger(line.precision) ? line.precision : 6 });
  }
  return out;
}
