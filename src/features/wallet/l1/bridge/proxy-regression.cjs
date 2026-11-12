// Run with B23_PROXY_ROOT pointing at the bridgeproxy checkout. All providers are mocked.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = process.env.B23_PROXY_ROOT;
if (!root) throw new Error('B23_PROXY_ROOT is required');
const name = process.argv[2] || 'test_eth_fast_lane_driver.js';
if (!['test_eth_fast_lane_driver.js', 'test_trustless_bridge_jobs_v2.js'].includes(name)) throw new Error('Unknown focused suite');
const file = path.join(root, 'wallet-proxy', name);
let source = fs.readFileSync(file, 'utf8');
// Extend upstream success fixtures with the new authenticated-anchor contract.
if (name === 'test_eth_fast_lane_driver.js') {
  source = source.replace("result.receipt_code = 'ACCEPTED';", "result.credited_asset_id = '8e'.repeat(48); result.receipt_code = 'ACCEPTED';");
  source = source.replace("if (process.env.MOCK_BAD_STAGE === stage)", "if (process.env.MOCK_MISSING_CREDIT === '1') delete result.credited_asset_id; if (process.env.MOCK_BAD_STAGE === stage)");
  source = source.replace("const badJobDir = path.join(root, 'job-b');", `const missingCredit = makeJob(path.join(root, 'job-missing-credit'), '18');
    process.env.MOCK_MISSING_CREDIT = '1';
    try {
      await assert.rejects(() => runJob(missingCredit, config), (error) => error.terminal === false);
      await assert.rejects(() => runJob(missingCredit, config), (error) => error.terminal === true);
      console.log('PASS missing credited asset cannot become accepted');
    } finally { delete process.env.MOCK_MISSING_CREDIT; }
    const badJobDir = path.join(root, 'job-b');`);
  source = source.replace('execution_rpc_sources_reachable: 2, beacon_finality_current: true',
    "execution_rpc_sources_reachable: 2, beacon_finality_current: true, beacon_anchor_authenticated: true, route_epoch: 12, beacon_anchor_route_epoch: 12, beacon_anchor_route_profile_hash: '${TEST_ROUTE_PROFILE_HASH}'");
  source = source.replace("assert.strictEqual(state.status, 'accepted');", `assert.strictEqual(state.status, 'accepted');
    assert.strictEqual(state.stage_history.length, 7);
    assert.strictEqual(state.asset_id, '8e'.repeat(48));
    assert.strictEqual(state.route_asset_id, TEST_ASSET_ID);
    for (const row of state.stage_history) {
      assert.strictEqual(row.status, 'complete');
      assert.ok(row.started_at_unix > 0 && row.completed_at_unix >= row.started_at_unix);
    }
    console.log('PASS seven durable stage timestamps survive retry/resume');`);
  source = source.replace('assert.strictEqual(ready.ready, true);', `assert.strictEqual(ready.ready, true);
    for (const patch of [
      { beacon_anchor_authenticated: undefined },
      { beacon_anchor_authenticated: false },
      { beacon_anchor_route_epoch: 11 },
      { beacon_anchor_route_profile_hash: 'ff'.repeat(48) },
      { route_epoch: undefined },
    ]) {
      const blocked = await readiness(config, ROUTE_ID, { execFileAsync: async () => ({ stdout: JSON.stringify({ ...ready, ...patch }) }) });
      assert.strictEqual(blocked.ready, false);
      assert.strictEqual(blocked.code, 'pfusdc_beacon_anchor_unavailable');
    }
    console.log('PASS missing, unauthenticated, wrong-epoch, wrong-profile anchors fail closed');`);
} else {
  source = source.replace('asset_id: routeRows[0].asset_id,', "asset_id: '8e'.repeat(48), route_asset_id: routeRows[0].asset_id,");
  source = source.replace('beacon_finality_current: route.source_chain_id === 1,', "beacon_finality_current: route.source_chain_id === 1, beacon_anchor_authenticated: true, route_epoch: 12, beacon_anchor_route_epoch: 12, beacon_anchor_route_profile_hash: route.route_profile_hash,");
}
const suite = new Module(file, module);
suite.filename = file;
suite.paths = Module._nodeModulePaths(path.dirname(file));
suite._compile(source, file);
