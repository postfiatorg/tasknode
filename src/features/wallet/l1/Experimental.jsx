import { Notice } from "./ui.jsx";

// Shown on every L1 wallet and NAVCoin page while the network is a test network.
export default function Experimental() {
  return <div className="l1-experimental" data-testid="l1-experimental"><Notice tone="warning" title="Experimental">This runs on the Post Fiat test network (devnet-2). USDC you bridge in is real USDC on Ethereum mainnet. Features can change or pause without notice, so use small amounts. Every block and transaction is public in the <a href="https://postfiat.org/explorer/" target="_blank" rel="noreferrer">explorer</a>.</Notice></div>;
}
