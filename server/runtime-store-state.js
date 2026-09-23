import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const defaultStorePath = path.join("/tmp", "tasknodeofficial-runtime-store.json");
export const storePath = process.env.TASKNODE_STORE_PATH || defaultStorePath;

const defaultState = {
  version: 1,
  conversations: { dev: [] },
  conversationMeta: {},
  ledgerEntries: [],
  sessions: {},
  accounts: {},
  accountEmails: {},
  accountIdentities: {},
  accountWallets: {},
  telegramBotPreferences: {},
  telegramBotEvents: [],
  walletInitiationGrants: [],
  accountDeletionAudit: [],
  ethereumDepositAccounts: {},
  ethereumDepositRetiredAccounts: [],
  ethereumDepositAddressIndex: {},
  ethereumDepositCursor: 0,
  walletChallenges: {},
  contextDocuments: {},
  contextHistorySnapshots: {},
  oauthStates: {},
  terminalAuthRequests: {},
  terminalSessions: {},
  emailChallenges: {},
  authEvents: [],
};

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeAccountProfileVisibility(account = null) {
  if (!account || typeof account !== "object") return account;
  account.profileVisibility = account.profileVisibility === "private" ? "private" : "public";
  return account;
}

function normalizeAccountsProfileVisibility(accounts = {}) {
  for (const account of Object.values(accounts || {})) normalizeAccountProfileVisibility(account);
  return accounts;
}

// A store that exists but cannot be parsed is moved aside, never reused as the
// base for the next save: starting from defaults and saving would overwrite it.
function readStoreOrQuarantine() {
  try {
    return JSON.parse(readFileSync(storePath, "utf8"));
  } catch (error) {
    const quarantinePath = `${storePath}.corrupt-${Date.now()}`;
    renameSync(storePath, quarantinePath);
    console.error("runtime_store_corrupt_quarantined", { quarantinePath, error: error?.message || String(error) });
    return null;
  }
}

function loadState() {
  if (!existsSync(storePath)) return structuredClone(defaultState);
  const parsed = readStoreOrQuarantine();
  if (!parsed) return structuredClone(defaultState);
  return {
    ...structuredClone(defaultState),
    ...parsed,
    conversations: parsed.conversations || structuredClone(defaultState.conversations),
    conversationMeta: plainObject(parsed.conversationMeta),
    ledgerEntries: Array.isArray(parsed.ledgerEntries) ? parsed.ledgerEntries : [],
    sessions: plainObject(parsed.sessions),
    accounts: normalizeAccountsProfileVisibility(plainObject(parsed.accounts)),
    accountEmails: plainObject(parsed.accountEmails),
    accountIdentities: plainObject(parsed.accountIdentities),
    accountWallets: plainObject(parsed.accountWallets),
    telegramBotPreferences: plainObject(parsed.telegramBotPreferences),
    telegramBotEvents: Array.isArray(parsed.telegramBotEvents) ? parsed.telegramBotEvents : [],
    walletInitiationGrants: Array.isArray(parsed.walletInitiationGrants) ? parsed.walletInitiationGrants : [],
    accountDeletionAudit: Array.isArray(parsed.accountDeletionAudit) ? parsed.accountDeletionAudit : [],
    ethereumDepositAccounts: plainObject(parsed.ethereumDepositAccounts),
    ethereumDepositRetiredAccounts: Array.isArray(parsed.ethereumDepositRetiredAccounts) ? parsed.ethereumDepositRetiredAccounts : [],
    ethereumDepositAddressIndex: plainObject(parsed.ethereumDepositAddressIndex),
    ethereumDepositCursor: Number.isSafeInteger(parsed.ethereumDepositCursor) ? parsed.ethereumDepositCursor : 0,
    walletChallenges: plainObject(parsed.walletChallenges),
    contextDocuments: plainObject(parsed.contextDocuments),
    contextHistorySnapshots: plainObject(parsed.contextHistorySnapshots),
    oauthStates: plainObject(parsed.oauthStates),
    terminalAuthRequests: plainObject(parsed.terminalAuthRequests),
    terminalSessions: plainObject(parsed.terminalSessions),
    emailChallenges: plainObject(parsed.emailChallenges),
    authEvents: Array.isArray(parsed.authEvents) ? parsed.authEvents : [],
  };
}

export const state = loadState();

export function saveState() {
  mkdirSync(path.dirname(storePath), { recursive: true });
  const tempPath = `${storePath}.tmp`;
  try {
    const fd = openSync(tempPath, "w", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(state)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, storePath);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup only; the existing store file remains intact.
    }
    throw error;
  }
}

export function runtimeStoreStatus() {
  return {
    path: storePath,
    defaultPath: defaultStorePath,
    explicit: Boolean(process.env.TASKNODE_STORE_PATH),
    ephemeralDefault: storePath === defaultStorePath || storePath.startsWith("/tmp/"),
  };
}

const legacyAuthStateKeys = ["sessions", "oauthStates", "emailChallenges", "walletChallenges"];

export function legacyAuthStateSnapshotForMigration() {
  return structuredClone(Object.fromEntries(legacyAuthStateKeys.map((key) => [key, state[key] || {}])));
}
export function legacyAccountWalletSnapshotForMigration() { return structuredClone(state.accountWallets || {}); }
export function legacyEthereumDepositSnapshotForMigration() {
  return structuredClone({
    active: state.ethereumDepositAccounts || {},
    retired: state.ethereumDepositRetiredAccounts || [],
    cursor: Number(state.ethereumDepositCursor || 0),
  });
}
export function legacyTerminalAuthSnapshotForMigration() {
  return structuredClone({ requests: state.terminalAuthRequests || {}, sessions: state.terminalSessions || {} });
}
export function legacyAccountStateSnapshotForMigration() {
  return structuredClone({ accounts: state.accounts || {}, emails: state.accountEmails || {}, identities: state.accountIdentities || {} });
}
// With accountIds, only those accounts (and their email/identity keys) are
// replaced; without, the whole durable snapshot replaces the cache.
export function replaceRuntimeAccountStateFromDurable({ accountIds = null, accounts = {}, emails = {}, identities = {} } = {}) {
  if (!accountIds) {
    state.accounts = plainObject(accounts);
    state.accountEmails = plainObject(emails);
    state.accountIdentities = plainObject(identities);
  } else {
    const ids = new Set(accountIds);
    for (const id of ids) delete state.accounts[id];
    for (const [key, id] of Object.entries(state.accountEmails)) if (ids.has(id)) delete state.accountEmails[key];
    for (const [key, id] of Object.entries(state.accountIdentities)) if (ids.has(id)) delete state.accountIdentities[key];
    Object.assign(state.accounts, plainObject(accounts));
    Object.assign(state.accountEmails, plainObject(emails));
    Object.assign(state.accountIdentities, plainObject(identities));
  }
  saveState();
}
export function clearLegacyTerminalAuthAfterMigration() {
  const counts = { requests: Object.keys(state.terminalAuthRequests || {}).length, sessions: Object.keys(state.terminalSessions || {}).length };
  state.terminalAuthRequests = {};
  state.terminalSessions = {};
  if (counts.requests > 0 || counts.sessions > 0) saveState();
  return counts;
}
export function clearLegacyEthereumDepositsAfterMigration() {
  const counts = { active: Object.keys(state.ethereumDepositAccounts || {}).length, retired: (state.ethereumDepositRetiredAccounts || []).length };
  state.ethereumDepositAccounts = {};
  state.ethereumDepositRetiredAccounts = [];
  state.ethereumDepositAddressIndex = {};
  state.ethereumDepositCursor = 0;
  if (counts.active > 0 || counts.retired > 0) saveState();
  return counts;
}
export function clearLegacyAuthStateAfterMigration() {
  const counts = Object.fromEntries(legacyAuthStateKeys.map((key) => [key, Object.keys(state[key] || {}).length]));
  legacyAuthStateKeys.forEach((key) => { state[key] = {}; });
  if (Object.values(counts).some((count) => count > 0)) saveState();
  return counts;
}
