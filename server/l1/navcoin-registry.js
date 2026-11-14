// Editorial metadata only. Prices, proof strength, supply and availability are RPC reads.
export function navcoinRegistry(config) {
  return [
    {
      slug: config.slug, name: config.symbol, asset_id: config.b23_asset_id,
      description: config.description, methodology: config.methodology,
      ethereum: config.ethereum, redemption_mode: config.redemption_mode,
      issue_multiplier_bps: config.issue_multiplier_bps, redeem_multiplier_bps: config.redeem_multiplier_bps,
      market_quote_asset_id: config.market_quote_asset_id, route_id: config.route_id,
    },
    ...config.retired_assets.map(coin => ({
      ...coin, name: coin.symbol, retired: true,
      description: "Retired NAVCoin. Existing holdings remain visible.",
      methodology: "This coin has been retired. Its NAV and verification below are historical and are not current backing or a redeemable price. Contact the issuer about any remaining holding or reserved payout.",
      market_quote_asset_id: config.market_quote_asset_id,
    })),
    {
      slug: "a666", name: "A666",
      asset_id: "300bf48a63a94770b6e67817f88cd1abf77e7f592a061e15682d7fd9973260af4c2e631e32df3c2c402b7d2fe272a293",
      description: "A NAVCoin tracking the StakeHub six-leg reserve portfolio.",
      methodology: "The operator posts a reserve portfolio valuation and circulating supply to Post Fiat. NAV per coin is the value allocated to each coin in that reading. The active chain profile identifies the source as stakehub-six-leg-reserves. A detailed asset-by-asset valuation methodology has not been published in this registry; the verification panel shows only what the chain packet actually supports.",
      market_quote_asset_id: config.market_quote_asset_id, route_id: "pftl-a666-ce22-sepolia-wA666-usdc-controlled-20260723-v1",
    },
  ];
}
