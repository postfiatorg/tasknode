import { accountWalletStorageStatus, migrateLegacyAccountWallets } from "./account-wallets.js";
import { accountStorageStatus, migrateLegacyAccounts } from "./accounts.js";
import { authChallengeStorageStatus } from "./auth-challenges.js";
import { authSessionStorageStatus } from "./auth-sessions.js";
import { migrateLegacyAuthState } from "./auth-state-migration.js";
import { ethereumDepositStorageStatus, migrateLegacyEthereumDeposits } from "./ethereum-deposit-accounts.js";
import { migrateLegacyTerminalAuth, terminalAuthStorageStatus } from "./terminal-auth.js";

export function assertDurableRuntimeAuthority() {
  const requirements = [
    [authSessionStorageStatus(), "sessions"],
    [accountStorageStatus(), "accounts"],
    [authChallengeStorageStatus(), "auth_challenges"],
    [accountWalletStorageStatus(), "wallet_links"],
    [ethereumDepositStorageStatus(), "deposit_accounts"],
    [terminalAuthStorageStatus(), "terminal_sessions"],
  ];
  const failed = requirements.find(([status]) => status.adapter !== "postgres");
  if (failed) throw new Error(`refusing_public_startup_with_nondurable_${failed[1]}`);
}

export async function migrateLegacyRuntimeAuthority() {
  return {
    accounts: await migrateLegacyAccounts(),
    auth: await migrateLegacyAuthState(),
    wallets: await migrateLegacyAccountWallets(),
    deposits: await migrateLegacyEthereumDeposits(),
    terminal: await migrateLegacyTerminalAuth(),
  };
}
