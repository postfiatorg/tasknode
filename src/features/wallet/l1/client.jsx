import { createContext, useContext } from "react";
export const L1WalletContext = createContext(null);
export function useL1Wallet() {
  const wallet = useContext(L1WalletContext);
  if (!wallet) throw new Error("L1 wallet context is unavailable");
  return wallet;
}
