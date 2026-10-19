#!/usr/bin/env node
/**
 * Live x402 test client for Factorium (staging / testnet).
 *
 * Performs the 402-then-paid flow against GET /attestations using a funded
 * Base Sepolia buyer key, and prints the settlement transaction hash from the
 * PAYMENT-RESPONSE header.
 *
 * Required env:
 *   BUYER_PRIVATE_KEY  - 0x-prefixed EVM private key with testnet USDC on the
 *                        target network (Base Sepolia by default)
 * Optional env:
 *   BASE_URL           - default http://localhost:3099
 *   NETWORK            - CAIP-2 network, default eip155:84532 (must match the
 *                        server's X402_NETWORK)
 *
 * Run: node scripts/test-x402.mjs
 */

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3099').replace(/\/+$/, '');
const NETWORK = process.env.NETWORK || 'eip155:84532';
const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY;

function fail(message) {
  console.error(`test-x402: ${message}`);
  process.exit(1);
}

if (!BUYER_PRIVATE_KEY) {
  fail('BUYER_PRIVATE_KEY env var is required (0x-prefixed key holding testnet USDC on ' + NETWORK + ')');
}
if (!BUYER_PRIVATE_KEY.startsWith('0x')) {
  fail('BUYER_PRIVATE_KEY must be 0x-prefixed');
}

const { wrapFetchWithPayment, x402Client } = await import('@x402/fetch');
const { decodePaymentResponseHeader } = await import('@x402/core/http');
const { ExactEvmScheme } = await import('@x402/evm/exact/client');
const { privateKeyToAccount } = await import('viem/accounts');

const account = privateKeyToAccount(BUYER_PRIVATE_KEY);
console.log(`Buyer address: ${account.address}`);
console.log(`Target: ${BASE_URL} (network ${NETWORK})`);

const client = new x402Client().register(NETWORK, new ExactEvmScheme(account));
const fetchWithPay = wrapFetchWithPayment(globalThis.fetch, client);

const url = `${BASE_URL}/attestations?limit=5`;
console.log(`\nGET ${url} (expecting 402 -> pay -> 200)...`);

const response = await fetchWithPay(url);
console.log(`Status: ${response.status}`);

if (response.status !== 200) {
  const body = await response.text().catch(() => '');
  fail(`expected 200 after payment, got ${response.status}. Body: ${body.slice(0, 500)}`);
}

const paymentResponseHeader = response.headers.get('payment-response');
if (!paymentResponseHeader) {
  fail('200 received but PAYMENT-RESPONSE header is missing (was x402 actually applied?)');
}

const settle = decodePaymentResponseHeader(paymentResponseHeader);
console.log(`\nPayment settled on ${settle.network}`);
console.log(`  payer:       ${settle.payer}`);
console.log(`  transaction: ${settle.transaction}`);
if (settle.network.startsWith('eip155:84532')) {
  console.log(`  explorer:    https://sepolia.basescan.org/tx/${settle.transaction}`);
} else if (settle.network.startsWith('eip155:8453')) {
  console.log(`  explorer:    https://basescan.org/tx/${settle.transaction}`);
}

const body = await response.json();
console.log(`\nMarketplace response: ${body.total ?? 0} attestation(s) returned`);
console.log('test-x402: OK');
