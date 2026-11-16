export const PUBLISHED_CONFIG = Object.freeze({
  symbol: "B23", slug: "b23", redemption_mode: "two-credit",
  description: "Backed by a Schwab brokerage account.",
  methodology: "NAV uses Schwab’s reported net liquidation value plus the native subscription reserve counted by the network. NAV per coin is this combined net asset value divided by the supply in the finalized reading. The Schwab reading is shown as Attested when supported by the enclave proof; the separate native reserve is Reported, not part of the attested Schwab value.",
  nav_asset_id: "ca7845134c8e95819082fcd2f1612808e20a37dfabab98dab120f99fd2c54c18ffb50d98c0664480420c881773244627",
  pfusdc_asset_id: "02c46a36eb0da3516b4d8affea8f4028ad3f36825a3e8f0e009ea9dbbbcfb3c233f6830bd5221fe2717fb6a1a7005d7b",
  route_id: "pftl-pfdep-schwab-primary-pfusdc-v1",
  issuer_address: "pffcb93d9f87a843a8aa34e1adf241f5d58143e81b",
  alice_holder_address: "pfab9b9228942e5c529633a13aa271d5297bec6353",
  management_address: null, proof_profile: null, g1_passed: false,
  pfusdc_source_asset_ids: ["2bae082a6703375b9405af44715e1e64623265392627767b040fa2c30abb100a09da403724a6f105317292d9c0073df7"],
});
