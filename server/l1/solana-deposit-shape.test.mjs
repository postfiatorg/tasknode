// The shared deposit shape check (solana-shape.js) on signed deposits, as the relay sees them on
// /send: the two-signer edits Phantom may make and main's one-signer rule. Split from
// solana-bridge.test.mjs, which covers the relay routes, leases and re-send loops.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import bs58 from 'bs58';
import { checkDepositShape } from '../../src/features/wallet/l1/bridge/solana-shape.js';
import { getProgramDerivedAddress } from '@solana/addresses';
import { AccountRole } from '@solana/instructions';
import { getCompiledTransactionMessageDecoder } from '@solana/transaction-messages';
import { assertLamports, pub, recompile, solanaDeposit, unitLimit, unitPrice, COMPUTE_BUDGET, LIGHTHOUSE } from '../../src/features/wallet/l1/bridge/solana-fixtures.mjs';

const keyOf = seed => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const addressOf = seed => bs58.encode(createPublicKey(keyOf(seed)).export({ format: 'der', type: 'spki' }).subarray(-32));
const program = pub(2), owner = addressOf(Buffer.alloc(32, 5)), mint = pub(7), source = pub(9);

// Edge cases of the shared shape check, signed by the depositor, as the relay sees them on /send.
const lighthouseIx = (tag, accounts = [], rest = []) => ({ programAddress: LIGHTHOUSE, data: Buffer.from([tag, ...rest]), accounts });
async function shapeCases(cases) {
  const nonce = '34'.repeat(32), base = { program, mint, owner, source, nonce, amount_atoms: '1000000', pftl_recipient: 'pf' + 'ab'.repeat(20) };
  const expected = { program, mint, nonce };
  for (const [label, edit, refusal] of cases) {
    // The depositor's slot is filled; a second (authority) slot stays empty until the relay signs.
    const bytes = Buffer.from(typeof edit === 'function' ? await edit(base) : await solanaDeposit({ ...base, ...edit })).fill(9, 1, 65);
    const result = checkDepositShape(bytes, expected, { signed: true });
    if (refusal) await assert.rejects(result, { message: 'Not the vault deposit: ' + refusal }, label);
    else await assert.doesNotReject(result, label);
  }
}

test('two signers: assertions may name the nonce account, writable for the advance; the authority and any other write stay outside the advance', async () => {
  const nonceAccount = pub(20), authority = pub(21);
  const durable = { nonceAccount, authority, lifetime: pub(22), budget: [unitLimit(200450), unitPrice(150000)] };
  const v0 = async base => {
    const bytes = await solanaDeposit({ ...base, ...durable });
    const start = 1 + 64 * bytes[0];
    return Buffer.concat([bytes.subarray(0, start), Buffer.from([0x80]), bytes.subarray(start), Buffer.from([0])]);
  };
  const cases = [
    ['baseline', {}],
    ['a v0 message without lookup tables', v0, 'message encoding'],
    ['Lighthouse with empty data', { extra: [{ ...lighthouseIx(2), data: Buffer.alloc(0) }] }, 'Lighthouse instruction'],
    ['Lighthouse tag 15 (clock), no accounts', { extra: [lighthouseIx(15, [], [0, 1, 2, 3])] }],
    ['Lighthouse tag 16 with unparsed data', { extra: [lighthouseIx(16, [], [0xff, 0xff])] }],
    ['a zero-account instruction to another program', { extra: [{ programAddress: pub(60), data: Buffer.from([1, 2, 3]) }] }, 'unexpected instruction count'],
    ['assertions on the owner and the source', { extra: [assertLamports(owner, 1), assertLamports(source, 1)] }],
    ['the compute budget after the deposit', { budget: [], extra: [unitPrice(150000), unitLimit(300000)] }],
    ['no limit, price 2,000,000, no assertions', { budget: [unitPrice(2_000_000)] }],
    ['no limit, price 1,000,000, one assertion', { budget: [unitPrice(1_000_000)], extra: [assertLamports(owner, 1)] }],
    ['no limit, price 2,000,000, one assertion', { budget: [unitPrice(2_000_000)], extra: [assertLamports(owner, 1)] }, 'compute budget cap'],
    ['limit 0', { budget: [unitLimit(0), unitPrice(150000)] }],
    ['an assertion on the nonce account', { extra: [assertLamports(nonceAccount, 1)] }],
    ['an assertion on the nonce account, compiled writable', { extra: [assertLamports(nonceAccount, 1, { role: 1 })] }],
    ['a multi-account assertion on the nonce account and the owner', { extra: [lighthouseIx(3, [{ address: nonceAccount, role: 0 }, { address: owner, role: 0 }], [0, 0])] }],
    ['an assertion on the authority', { extra: [assertLamports(authority, 1)] }, 'nonce account or authority outside advance'],
    ['an assertion on the nonce account and the authority', { extra: [lighthouseIx(3, [{ address: nonceAccount, role: 0 }, { address: authority, role: 0 }], [0, 0])] },
      'nonce account or authority outside advance'],
    ['MemoryWrite on the nonce account', { extra: [lighthouseIx(0, [{ address: nonceAccount, role: 1 }])] }, 'Lighthouse instruction'],
    ['an assertion before the advance', { first: [assertLamports(nonceAccount, 1)] }, 'advance nonce must be first'],
    ['the nonce account as the deposit source', { source: nonceAccount }, 'nonce account or authority outside advance'],
  ];
  await shapeCases(cases.map(([label, edit, refusal]) => [label, typeof edit === 'function' ? edit : { ...durable, ...edit }, refusal]));
});

// main's one-signer rule, unchanged: the only path in production, and nobody has captured which
// Lighthouse instructions Phantom adds there. They pass as signed, unread. The default-limit fee
// bound applies only to two signers (left open on purpose: the depositor pays and approves it).
test('one signer: Lighthouse instructions pass as signed, whatever their tag, as on main', async () => {
  const budget = [unitLimit(200450), unitPrice(150000)];
  await shapeCases([
    ['Lighthouse tag 0 (MemoryWrite)', { budget, extra: [lighthouseIx(0)] }],
    ['Lighthouse tag 1 (MemoryClose)', { budget, extra: [lighthouseIx(1)] }],
    ['Lighthouse tag 99', { budget, extra: [lighthouseIx(99)] }],
    ['Lighthouse with empty data', { budget, extra: [{ ...lighthouseIx(2), data: Buffer.alloc(0) }] }],
    ['Lighthouse with a new writable account', { budget, extra: [assertLamports(pub(70), 1, { role: 1 })] }],
    ['no limit, price 2,000,000, five assertions', { budget: [unitPrice(2_000_000)], extra: Array.from({ length: 5 }, () => assertLamports(owner, 1)) }],
    ['another program', { budget, extra: [assertLamports(owner, 1, { programAddress: pub(43) })] }, 'unexpected instruction count'],
    ['an added signer, read as two signers without an advance', { budget, extra: [assertLamports(pub(44), 1, { role: 2 })] }, 'unexpected instruction count'],
    // Beyond main's one-signer rule, only what Solana itself refuses: over 1232 bytes, or a header it rejects.
    ['over 1232 bytes', { budget, extra: [lighthouseIx(5, [], Array(1100).fill(0))] }, 'transaction size'],
    ['a key listed twice', async base => recompile(await solanaDeposit({ ...base, budget }),
      m => ({ ...m, staticAccounts: m.staticAccounts.map((key, i, keys) => i === keys.length - 1 ? keys[1] : key) })), 'account header'],
    ['a read-only fee payer', async base => recompile(await solanaDeposit({ ...base, budget }),
      m => ({ ...m, header: { ...m.header, numReadonlySignerAccounts: 1 } })), 'account header'],
    ['more read-only keys than unsigned keys', async base => recompile(await solanaDeposit({ ...base, budget }),
      m => ({ ...m, header: { ...m.header, numReadonlyNonSignerAccounts: m.staticAccounts.length } })), 'account header'],
  ]);
});

// The shape of a real one-signer deposit made from the Task Node screen with Phantom on production
// on 24 November (0.05 USDC, credited, fee 25,045 lamports), with synthetic keys: a limit of
// 200,450 units at 100,000 micro-lamports, four Lighthouse instructions, the vault deposit, then two
// more. Each Lighthouse instruction has the real one's tag, data length and named account; its
// data after the tag and log level is zeroed. Both the relay on /send and the browser after
// Phantom accept it as signed.
test('one signer: a production Phantom deposit with two compute-budget instructions, four Lighthouse instructions, the vault deposit and two more passes', async () => {
  const nonce = '35'.repeat(32), request = { owner, amount_atoms: '50000', pftl_recipient: 'pf' + 'ab'.repeat(20) };
  const pda = async (...seeds) => (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];
  const [config, custody, receipt] = await Promise.all([pda('config'), pda('custody'), pda('receipt', Buffer.from(nonce, 'hex'))]);
  const lighthouse = (tag, length, address) => ({ programAddress: LIGHTHOUSE,
    data: Buffer.concat([Buffer.from([tag, 4]), Buffer.alloc(length - 2)]), accounts: [{ address, role: AccountRole.READONLY }] });
  const bytes = Buffer.from(await solanaDeposit({ program, mint, source, nonce, ...request,
    first: [unitLimit(200450), unitPrice(100000), lighthouse(10, 84, custody), lighthouse(6, 52, source),
      lighthouse(6, 37, config), lighthouse(6, 13, receipt)],
    extra: [lighthouse(6, 26, owner), lighthouse(10, 17, source)] })).fill(9, 1, 65);
  const { header, staticAccounts, instructions } = getCompiledTransactionMessageDecoder().decode(bytes.subarray(65));
  assert.equal(bytes[0], 1);
  assert.equal(header.numSignerAccounts, 1);
  assert.deepEqual(instructions.map(ix => staticAccounts[ix.programAddressIndex]),
    [COMPUTE_BUDGET, COMPUTE_BUDGET, LIGHTHOUSE, LIGHTHOUSE, LIGHTHOUSE, LIGHTHOUSE, program, LIGHTHOUSE, LIGHTHOUSE]);
  assert.equal(5000 + Math.ceil(200450 * 100000 / 1e6), 25045, 'the fee Solana charged');
  // The relay's check on /send, then the browser's after Phantom returns.
  await assert.doesNotReject(checkDepositShape(bytes, { program, mint, nonce }, { signed: true }));
  await assert.doesNotReject(checkDepositShape(bytes, { ...request, program, mint, nonce }, { signed: true }));
});
