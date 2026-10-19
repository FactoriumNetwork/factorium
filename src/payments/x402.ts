import { v4 as uuid } from 'uuid';
import {
  HTTPFacilitatorClient,
  x402ResourceServer,
  type FacilitatorConfig,
  type HTTPRequestContext,
  type HTTPTransportContext,
  type RoutesConfig,
  type SettleResultContext,
} from '@x402/core/server';
import type { Network, Price } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { getDatabase } from '../registry/database.js';
import { getAttestation } from '../registry/attestations.js';

/**
 * x402 (HTTP 402) payment support — USDC on Base via an x402 facilitator.
 *
 * Disabled by default. When X402_ENABLED=true the REST layer mounts
 * paymentMiddleware() with the route config from buildX402RouteConfig(),
 * and successful settlements are recorded here in the Postgres ledger via
 * the onAfterSettle hook (the single source of truth for x402 crediting).
 *
 * PRICE UNIT MAPPING: attestation `price` and bounty `reward` are stored as
 * internal ledger units (the legacy Lightning path calls them "sats"). For
 * x402 pricing we treat the same number as cents USD: price 5 => "$0.05",
 * price 100 => "$1". Ledger entries stay in the original units — only the
 * x402 wire representation interprets them as USD.
 */

const DEFAULT_NETWORK = 'eip155:84532'; // Base Sepolia (testnet)
const DEFAULT_FACILITATOR_URL = 'https://x402.org/facilitator'; // keyless public testnet facilitator
const MARKETPLACE_WALLET_OWNER = 'marketplace';

interface X402Config {
  enabled: boolean;
  network: Network;
  payTo: string | null;
  facilitatorUrl: string;
  cdpApiKeyId: string | null;
  cdpApiKeySecret: string | null;
}

function getX402Config(): X402Config {
  const enabledRaw = (process.env.X402_ENABLED || '').trim().toLowerCase();
  return {
    enabled: enabledRaw === 'true' || enabledRaw === '1',
    network: (process.env.X402_NETWORK || DEFAULT_NETWORK) as Network,
    payTo: process.env.X402_PAY_TO?.trim() || null,
    facilitatorUrl: process.env.X402_FACILITATOR_URL?.trim() || DEFAULT_FACILITATOR_URL,
    cdpApiKeyId: process.env.CDP_API_KEY_ID?.trim() || null,
    cdpApiKeySecret: process.env.CDP_API_KEY_SECRET?.trim() || null,
  };
}

export function isX402Enabled(): boolean {
  return getX402Config().enabled;
}

export function getX402Network(): Network {
  return getX402Config().network;
}

export function getX402PayTo(): string {
  const { payTo } = getX402Config();
  if (!payTo) {
    throw new Error('X402_PAY_TO is required when X402_ENABLED=true (Base address that receives USDC payments)');
  }
  return payTo;
}

/** Public status payload for GET /x402/info (never includes secrets). */
export function getX402Info(): { enabled: boolean; network: Network; payTo: string | null; facilitatorUrl: string } {
  const config = getX402Config();
  return {
    enabled: config.enabled,
    network: config.network,
    payTo: config.enabled ? config.payTo : null,
    facilitatorUrl: config.facilitatorUrl,
  };
}

/** Convert stored cents-USD units to an x402 Money string. price 5 => "$0.05". */
function centsToUsdPrice(cents: number): Price {
  if (!Number.isFinite(cents) || cents <= 0) {
    throw new Error(`Cannot map non-positive price to x402 USD amount: ${cents}`);
  }
  // 4 decimal places covers sub-cent precision; trim trailing zeros ("0.0500" -> "0.05").
  return `$${(cents / 100).toFixed(4).replace(/\.?0+$/, '')}`;
}

/** Extract the attestation id from a `/attestations/:id/purchase` path. */
function attestationIdFromPurchasePath(path: string): string | null {
  const match = /^\/attestations\/([^/]+)\/purchase\/?$/.exec(path.split(/[?#]/)[0]);
  return match ? match[1] : null;
}

function isCdpFacilitatorUrl(url: string): boolean {
  return url.includes('cdp.coinbase.com');
}

/**
 * Records an x402-settled attestation purchase in the Postgres ledger.
 *
 * This is the ONLY place x402 purchases are credited: the REST purchase
 * handler skips the internal purchaseAttestation() money movement when
 * x402 is enabled, so there is exactly one source of truth.
 *
 * Mirrors purchaseAttestation()'s 90/10 split in internal ledger units:
 * verifier gets price - 10% fee, marketplace gets the fee. buyer_id is the
 * payer's wallet address from the settled payment. Wrapped in a pg
 * transaction so the wallet credits, transaction row, and access_count
 * bump are atomic.
 */
async function recordX402PurchaseSettlement(ctx: SettleResultContext): Promise<void> {
  const transport = ctx.transportContext as HTTPTransportContext | undefined;
  const request = transport?.request;
  if (!request || request.method !== 'POST') return;

  const attestationId = attestationIdFromPurchasePath(request.path);
  if (!attestationId) return; // some other gated route settled — nothing to record
  if (!ctx.result.success) return;

  const attestation = await getAttestation(attestationId);
  if (!attestation) {
    console.error(`[x402] settled payment for unknown attestation ${attestationId} (tx ${ctx.result.transaction}) — ledger write skipped`);
    return;
  }

  const payer = ctx.result.payer || 'unknown';
  const txHash = ctx.result.transaction;
  const fee = Math.round(attestation.price * 0.1 * 100) / 100;
  const payout = attestation.price - fee;
  const txnId = uuid();

  const db = getDatabase();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Ensure the verifier has a wallet row, then credit the 90% payout.
    await client.query(
      `INSERT INTO payment_wallets (id, owner_id, owner_type, balance, created_at)
       VALUES ($1, $2, 'verifier', 0, NOW() AT TIME ZONE 'utc')
       ON CONFLICT (owner_id) DO NOTHING`,
      [uuid(), attestation.verifierId]
    );
    await client.query('UPDATE payment_wallets SET balance = balance + $1 WHERE owner_id = $2', [payout, attestation.verifierId]);

    // Credit the 10% marketplace fee (row is created by initDatabase).
    await client.query('UPDATE payment_wallets SET balance = balance + $1 WHERE owner_id = $2', [fee, MARKETPLACE_WALLET_OWNER]);

    await client.query(
      `INSERT INTO transactions (id, attestation_id, buyer_id, verifier_id, amount, marketplace_fee, verifier_payout, tx_hash, payer_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [txnId, attestationId, payer, attestation.verifierId, attestation.price, fee, payout, txHash, payer]
    );

    await client.query('UPDATE attestations SET access_count = access_count + 1 WHERE id = $1', [attestationId]);

    await client.query('COMMIT');
    console.log(`[x402] recorded purchase settlement: attestation=${attestationId} payer=${payer} tx=${txHash} payout=${payout} fee=${fee}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

let resourceServer: x402ResourceServer | null = null;

/**
 * Lazy singleton x402ResourceServer: HTTPFacilitatorClient + ExactEvmScheme
 * on the configured network, with the purchase ledger hook attached.
 */
export function getX402ResourceServer(): x402ResourceServer {
  if (!resourceServer) {
    const config = getX402Config();

    const facilitatorConfig: FacilitatorConfig = { url: config.facilitatorUrl };
    if (config.cdpApiKeyId && config.cdpApiKeySecret && isCdpFacilitatorUrl(config.facilitatorUrl)) {
      // TODO(cdp-auth): CDP's hosted facilitator authenticates each request with
      // a short-lived ES256 JWT derived from CDP_API_KEY_ID/CDP_API_KEY_SECRET
      // (see `generateJwt` in @coinbase/cdp-sdk). That package is not a
      // dependency yet, so no `createAuthHeaders` is wired here and CDP
      // facilitator requests will go out unauthenticated (expect 401s until
      // this is wired). The keyless public facilitator works without any of
      // this — leave X402_FACILITATOR_URL unset to use it.
      console.warn('[x402] CDP facilitator URL with CDP_API_KEY_ID/SECRET set, but CDP JWT auth is not wired yet (see TODO in src/payments/x402.ts). Sending facilitator requests unauthenticated.');
    }

    const facilitator = new HTTPFacilitatorClient(facilitatorConfig);
    resourceServer = new x402ResourceServer(facilitator)
      .register(config.network, new ExactEvmScheme())
      .onAfterSettle(recordX402PurchaseSettlement);
  }
  return resourceServer;
}

/**
 * Route config for paymentMiddleware(). Only call when x402 is enabled —
 * throws a clear error when X402_ENABLED=true but X402_PAY_TO is missing.
 */
export function buildX402RouteConfig(): RoutesConfig {
  const config = getX402Config();
  if (!config.enabled) {
    throw new Error('buildX402RouteConfig() called while x402 is disabled (set X402_ENABLED=true to enable)');
  }
  const payTo = getX402PayTo();
  const network = config.network;

  return {
    'GET /attestations': {
      accepts: [{ scheme: 'exact', network, payTo, price: '$0.001' }],
      description: 'Query the Factorium attestation marketplace for existing verifications',
      mimeType: 'application/json',
      extensions: declareDiscoveryExtension({
        // Query-param (GET-style) discovery: no `method`/`bodyType` fields —
        // the input type distinguishes query configs by the absence of bodyType.
        input: { type: 'deepfake-detection', minConfidence: 0.9 },
        inputSchema: {
          properties: {
            type: { type: 'string', description: 'Attestation type filter (deepfake-detection, fact-check, ...)' },
            subject: { type: 'string', description: 'Free-text subject search' },
            subjectHash: { type: 'string', description: 'SHA-256 of the subject' },
            verifierId: { type: 'string', description: 'Filter by verifier' },
            minConfidence: { type: 'number', description: 'Minimum confidence (0-1)' },
            maxPrice: { type: 'number', description: 'Maximum price per attestation' },
            limit: { type: 'number', description: 'Max results (default 50)' },
          },
        },
        output: {
          example: { attestations: [], total: 0, queryCost: 0, cheapestPrice: null, averagePrice: null },
        },
      }),
    },

    'POST /attestations/:id/purchase': {
      accepts: [{
        scheme: 'exact',
        network,
        payTo,
        // Dynamic price: resolve the attestation's stored price (cents USD)
        // into an x402 Money string at request time. Throws if missing, which
        // surfaces as a 500 before any payment is attempted.
        price: async (ctx: HTTPRequestContext): Promise<Price> => {
          const id = attestationIdFromPurchasePath(ctx.path);
          if (!id) throw new Error(`Cannot resolve attestation id from path: ${ctx.path}`);
          const attestation = await getAttestation(id);
          if (!attestation) throw new Error(`Attestation not found: ${id}`);
          return centsToUsdPrice(attestation.price);
        },
      }],
      description: 'Purchase access to a verified attestation (90% to verifier, 10% marketplace fee)',
      mimeType: 'application/json',
    },

    'POST /bounties': {
      accepts: [{
        scheme: 'exact',
        network,
        payTo,
        // Dynamic price: the bounty reward (cents USD) from the JSON body.
        price: async (ctx: HTTPRequestContext): Promise<Price> => {
          const body = ctx.adapter.getBody?.() as { reward?: unknown } | undefined;
          const reward = typeof body?.reward === 'number' ? body.reward : Number(body?.reward);
          if (!Number.isFinite(reward) || reward <= 0) {
            throw new Error('POST /bounties requires a positive numeric `reward` in the request body for x402 pricing');
          }
          return centsToUsdPrice(reward);
        },
      }],
      description: 'Post a funded bounty (reward charged via x402)',
      mimeType: 'application/json',
    },
  };
}
