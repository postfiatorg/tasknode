// Editorial metadata only. Prices, proof strength, supply and availability are RPC reads.
export function navcoinRegistry(config) {
  return [
    {
      slug: "b23", name: "B23", asset_id: config.b23_asset_id,
      description: "Backed by a Schwab brokerage account.",
      methodology: "NAV is Schwab’s reported net liquidation value at the daily 18:15 UTC cutoff, with no adjustments of ours. NAV per coin is the account value allocated across the coins in the finalized reading. The separate PFUSDC cash-in reserve is not added to that account value.",
      market_quote_asset_id: config.market_quote_asset_id, route_id: config.route_id,
    },
    {
      slug: "a666", name: "A666",
      asset_id: "300bf48a63a94770b6e67817f88cd1abf77e7f592a061e15682d7fd9973260af4c2e631e32df3c2c402b7d2fe272a293",
      description: "A NAVCoin tracking the StakeHub six-leg reserve portfolio.",
      methodology: "The operator posts a reserve portfolio valuation and circulating supply to Post Fiat. NAV per coin is the value allocated to each coin in that reading. The active chain profile identifies the source as stakehub-six-leg-reserves. A detailed asset-by-asset valuation methodology has not been published in this registry; the verification panel shows only what the chain packet actually supports.",
      market_quote_asset_id: config.market_quote_asset_id, route_id: null,
    },
  ];
}
