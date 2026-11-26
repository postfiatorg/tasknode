// What a Solana payout address is. The first chain version pays the burn's 32-byte owner through
// that owner's USDC account and does not check the owner, so only a wallet may be named: an
// address with no account yet, or a System-owned account that is not a program.
const SYSTEM = "11111111111111111111111111111111";
const OWNERS = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "token_account",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "token_account",
  Stake11111111111111111111111111111111111111: "stake_account",
};
export const WALLET_NEEDED = "Enter your Solana wallet address: USDC is paid to that wallet.";
const TEXT = {
  off_curve: "This address is not a wallet: it is a program-derived address, such as a USDC token account.",
  token_account: "This address is a token account, not a wallet.",
  stake_account: "This address is a stake account, not a wallet.",
  program: "This address is a Solana program, not a wallet.",
  program_owned: "This address is an account held by a Solana program, not a wallet.",
};
export const UNCHECKED = "The Solana address could not be checked right now. No burn was built; try again shortly.";

export function recipientKind(account) {
  if (!account) return "wallet";
  if (account.executable === true) return "program";
  return account.owner === SYSTEM ? "wallet" : OWNERS[account.owner] || "program_owned";
}
export const recipientRefusal = kind => Object.hasOwn(TEXT, kind) ? `${TEXT[kind]} ${WALLET_NEEDED}` : UNCHECKED;
