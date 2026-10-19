#!/usr/bin/env node
/**
 * Static wiring check for the x402 module. Runnable without a wallet, a
 * database, or X402 env vars — imports the BUILT module from dist and asserts
 * env-driven behavior. Run `npm run build` first.
 *
 * Run: node scripts/check-x402-wiring.mjs
 */

import { strict as assert } from 'node:assert';

// Ensure a clean slate: this check must pass in environments where none of
// the X402_* vars are set.
delete process.env.X402_ENABLED;
delete process.env.X402_PAY_TO;
delete process.env.X402_NETWORK;
delete process.env.X402_FACILITATOR_URL;
delete process.env.CDP_API_KEY_ID;
delete process.env.CDP_API_KEY_SECRET;

const x402 = await import('../dist/src/payments/x402.js');

assert.equal(typeof x402.isX402Enabled, 'function', 'isX402Enabled should be exported');
assert.equal(typeof x402.getX402ResourceServer, 'function', 'getX402ResourceServer should be exported');
assert.equal(typeof x402.buildX402RouteConfig, 'function', 'buildX402RouteConfig should be exported');
assert.equal(typeof x402.getX402Info, 'function', 'getX402Info should be exported');
console.log('ok: module loads with expected exports');

assert.equal(x402.isX402Enabled(), false, 'x402 must be disabled by default (no env)');
console.log('ok: disabled by default with no env');

const info = x402.getX402Info();
assert.equal(info.enabled, false, 'info.enabled false by default');
assert.equal(info.payTo, null, 'info.payTo null when disabled');
assert.equal(info.network, 'eip155:84532', 'default network is Base Sepolia');
assert.ok(info.facilitatorUrl.length > 0, 'facilitatorUrl present');
console.log('ok: getX402Info() safe defaults');

process.env.X402_ENABLED = 'true';
assert.equal(x402.isX402Enabled(), true, 'X402_ENABLED=true enables');
console.log('ok: X402_ENABLED=true reads at call time');

assert.throws(
  () => x402.buildX402RouteConfig(),
  /X402_PAY_TO/,
  'buildX402RouteConfig must throw a clear X402_PAY_TO error when enabled without a payTo address'
);
console.log('ok: enabled-but-missing PAY_TO throws clear error');

process.env.X402_PAY_TO = '0x0000000000000000000000000000000000000001';
const routes = x402.buildX402RouteConfig();
assert.ok(routes && typeof routes === 'object', 'route config returned');
for (const key of ['GET /attestations', 'POST /attestations/:id/purchase', 'POST /bounties']) {
  assert.ok(key in routes, `route config includes ${key}`);
  assert.ok(routes[key].accepts, `${key} has accepts entries`);
}
assert.equal(routes['GET /attestations'].accepts[0].price, '$0.001', 'query price is $0.001');
assert.equal(
  typeof routes['POST /attestations/:id/purchase'].accepts[0].price, 'function',
  'purchase price is a dynamic resolver'
);
assert.equal(
  typeof routes['POST /bounties'].accepts[0].price, 'function',
  'bounty price is a dynamic resolver'
);
assert.equal(routes['POST /bounties'].accepts[0].payTo, process.env.X402_PAY_TO, 'payTo wired into accepts');
console.log('ok: route config shape (3 gated routes, dynamic resolvers, payTo)');

const server = x402.getX402ResourceServer();
assert.ok(server, 'resource server built');
assert.equal(x402.getX402ResourceServer(), server, 'resource server is a singleton');
console.log('ok: lazy resource server singleton');

delete process.env.X402_ENABLED;
delete process.env.X402_PAY_TO;

console.log('check-x402-wiring: all checks passed');
