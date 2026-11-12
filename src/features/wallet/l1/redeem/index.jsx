import { useState } from "react";
import { units } from "../market/amounts.js";
import { snapshot } from "../market/model.js";
import { ActionReview, PoolState, useNavcoin, WalletNotice } from "../market/ui.jsx";
import { buildRedeem, redeemPreflight, verifyRedeem } from "./model.js";
export default function RedeemTab({ client }) {
  const { data, error, loading, refresh } = useNavcoin(client);
  const [quantity, setQuantity] = useState(""), [request, setRequest] = useState(null), [estimate, setEstimate] = useState(null), [actionError, setActionError] = useState("");
  function review(event) {
    event.preventDefault(); setActionError(""); setRequest(null); setEstimate(null);
    try {
      const { intent, quote } = buildRedeem(data.config, client.address, data.state, quantity);
      setEstimate(quote);
      setRequest({ id: crypto.randomUUID(), accountId: client.accountId, address: client.address, intent,
        description: `Burn ${units(quote.amount)} B23. Pay ${units(quote.holder)} PFUSDC to this wallet and ${units(quote.management)} PFUSDC to management in the same transaction.`,
        read: () => snapshot(client, data.config, { management: true }),
        preflight: (intent, current, prepared) => redeemPreflight(data.config, intent, current, prepared),
        verify: (intent, before, after, receipt) => verifyRedeem(data.config, intent, before, after, receipt),
      });
    } catch (e) { setActionError(e.message); }
  }
  const visibleRequest = request?.accountId === client.accountId && request?.address === client.address && client.unlocked;
  return <div className="nc"><h2>Redeem B23</h2><p>Any holder can redeem at the finalized NAV minus the current fee, within the PFUSDC reserve and policy capacity.</p>
    <WalletNotice client={client} error={error} loading={loading} refresh={refresh} />
    {data && <><PoolState state={data.state} config={data.config} /><section className="nc-card"><h3>Redemption quote</h3><form onSubmit={review}>
      <label>B23 to redeem<input inputMode="decimal" value={quantity} onChange={e => { setQuantity(e.target.value); setRequest(null); setEstimate(null); }} required /></label>
      <button type="submit" disabled={!data.config.g1_passed}>Review redemption quote</button></form>
      {estimate && visibleRequest && <dl className="nc-grid"><div><dt>Full NAV / reserve debit</dt><dd>{units(estimate.gross)} PFUSDC</dd></div><div><dt>Holder receives</dt><dd>{units(estimate.holder)} PFUSDC</dd></div><div><dt>Management receives ({estimate.feeBps} bps)</dt><dd>{units(estimate.management)} PFUSDC</dd></div></dl>}
    </section></>}
    {actionError && <p role="alert">{actionError}</p>}{visibleRequest && <ActionReview key={request.id} client={client} request={request} onComplete={refresh} />}
  </div>;
}
