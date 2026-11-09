import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import {
  submitAttestation, queryAttestations, purchaseAttestation,
  getAttestation, disputeAttestation, hashSubject, getAttestationsByVerifier,
} from '../registry/attestations.js';
import {
  registerVerifier, getVerifier, listVerifiers, stake,
  getTopVerifiers, getStakingHistory,
} from '../registry/verifiers.js';
import {
  getMarketplaceStats, getRecentTransactions, getBuyerHistory,
} from '../marketplace/marketplace.js';
import {
  AttestationSubmissionSchema, VerifierRegistrationSchema,
  AttestationQuerySchema, DisputeSchema, SignupSchema,
} from '../types/index.js';
import {
  getOrCreateWallet, getWallet, createDepositInvoice,
  confirmDeposit, withdrawFunds,
} from '../payments/wallets.js';
import { isLightningConfigured } from '../payments/provider.js';
import { paymentMiddleware } from '@x402/express';
import { isX402Enabled, getX402ResourceServer, buildX402RouteConfig, getX402Info } from '../payments/x402.js';
import { logApiRequest, logActivity, getUsageReport } from '../monitoring/usage.js';
import { autoSeedDailyIfNeeded } from '../scheduler/auto-seed.js';
import { onboardAgent } from '../onboarding/agent-onboard.js';
import {
  postBounty, getBounty, listOpenBounties, claimBounty,
  fulfillBounty, cancelBounty, getBountiesByPoster,
} from '../bounties/bounty-market.js';
import { generateApiKey, validateApiKeyAsync } from '../auth/keys.js';
import { canonicalAttestationPayload, verifyPayload } from '../trust/signing.js';
import { renderLanding, renderDashboard, renderLogin } from '../dashboard/html.js';
import { getOrCreateMCPServer, createMCPHttpTransport, createAndConnectMCPTransport } from '../mcp/server.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Factorium — Attestation Marketplace Protocol',
    description:
      'Decentralized marketplace where AI systems buy and sell verified attestations. ' +
      'Eliminate redundant compute: query pre-computed verification results, buy them instead of re-running them, ' +
      'and earn royalties when others buy yours. 10% marketplace fee, 10x verifier stake requirement.',
    version: '1.0.7',
    contact: { name: 'Factorium', url: 'https://factorium.network' },
  },
  servers: [{ url: 'https://factorium.network', description: 'Production' }],
  components: {
    securitySchemes: {
      agentAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Agent-Id',
        description: 'Agent ID from POST /signup. Pair with the X-Api-Key header.',
      },
      apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
    },
    schemas: {
      Attestation: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: ['content-authenticity', 'identity-verification', 'document-validation', 'deepfake-detection', 'code-audit', 'fact-check', 'custom'] },
          subject: { type: 'string' },
          subjectHash: { type: 'string', description: 'Lowercase hex SHA-256 of the subject' },
          result: { type: 'string' },
          resultSummary: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          verifierId: { type: 'string' },
          verifierSignature: { type: 'string', description: 'Base64 ed25519 signature over the canonical payload' },
          price: { type: 'number' },
          royaltyPerAccess: { type: 'number' },
          createdAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          accessCount: { type: 'integer' },
          disputed: { type: 'boolean' },
          metadata: { type: 'object' },
        },
      },
      Verifier: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          endpoint: { type: 'string' },
          publicKey: { type: 'string' },
          stakedAmount: { type: 'number' },
          reputationScore: { type: 'number' },
          totalAttestations: { type: 'integer' },
          disputedAttestations: { type: 'integer' },
          active: { type: 'boolean' },
        },
      },
      Bounty: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          subject: { type: 'string' },
          reward: { type: 'number' },
          postedBy: { type: 'string' },
          status: { type: 'string', enum: ['open', 'claimed', 'fulfilled', 'expired', 'cancelled'] },
          createdAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },
      Error: { type: 'object', properties: { error: { type: 'string' } } },
    },
  },
  paths: {
    '/signup': {
      post: {
        summary: 'Create an agent account',
        description: 'Returns an agentId and a one-time API key. New agents receive 1,000 credits once.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } },
        responses: { '201': { description: 'Agent created' }, '400': { description: 'Invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
      },
    },
    '/attestations': {
      get: {
        summary: 'Query attestations',
        parameters: [
          { name: 'type', in: 'query', schema: { type: 'string' } },
          { name: 'subject', in: 'query', schema: { type: 'string', description: 'Case-insensitive substring match' } },
          { name: 'subjectHash', in: 'query', schema: { type: 'string' } },
          { name: 'verifierId', in: 'query', schema: { type: 'string' } },
          { name: 'minConfidence', in: 'query', schema: { type: 'number' } },
          { name: 'maxPrice', in: 'query', schema: { type: 'number' } },
          { name: 'limit', in: 'query', schema: { type: 'number', default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'number', default: 0 } },
          { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['price', 'confidence', 'createdAt', 'reputation'] } },
          { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
        ],
        responses: { '200': { description: 'Attestation query results' } },
      },
      post: {
        summary: 'Submit new attestation (auth required)',
        description:
          'Requires an ed25519 signature (base64) over the canonical payload ' +
          '{"confidence","price","result","subjectHash","type","verifierId"} with keys sorted and no whitespace. ' +
          'subjectHash is the lowercase hex SHA-256 of the subject string. ' +
          'Register a verifier without publicKey to receive a generated privateKeyPem once. ' +
          'The verifier must stake at least 10x the attestation price.',
        security: [{ agentAuth: [], apiKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['type', 'subject', 'result', 'resultSummary', 'confidence', 'verifierId', 'price', 'signature'],
                properties: {
                  type: { type: 'string' },
                  subject: { type: 'string' },
                  result: { type: 'string' },
                  resultSummary: { type: 'string', maxLength: 500 },
                  confidence: { type: 'number' },
                  verifierId: { type: 'string' },
                  price: { type: 'number' },
                  signature: { type: 'string' },
                  royaltyPerAccess: { type: 'number' },
                  expiresInSeconds: { type: 'number', nullable: true },
                  metadata: { type: 'object' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Attestation created' }, '400': { description: 'Invalid input or signature' } },
      },
    },
    '/attestations/{id}': {
      get: {
        summary: 'Get one attestation',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Attestation', content: { 'application/json': { schema: { $ref: '#/components/schemas/Attestation' } } } }, '404': { description: 'Not found' } },
      },
    },
    '/attestations/{id}/verify': {
      get: {
        summary: 'Verify an attestation signature',
        description: 'Returns signatureValid, the verifier public key, and a reason. Legacy unsigned attestations report reason=legacy-unsigned.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Verification result' }, '404': { description: 'Not found' } },
      },
    },
    '/attestations/{id}/purchase': {
      post: {
        summary: 'Purchase full access to an attestation (auth required)',
        description: 'Deducts the price from the buyer wallet, pays the verifier 90% and the marketplace 10%.',
        security: [{ agentAuth: [], apiKey: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['buyerId'], properties: { buyerId: { type: 'string' } } } } } },
        responses: { '200': { description: 'Purchase complete' }, '400': { description: 'Insufficient balance or invalid id' } },
      },
    },
    '/attestations/{id}/dispute': {
      post: {
        summary: 'Dispute an attestation (auth required)',
        security: [{ agentAuth: [], apiKey: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' }, evidence: { type: 'string' } } } } } },
        responses: { '200': { description: 'Dispute filed' } },
      },
    },
    '/bounties': {
      get: {
        summary: 'List open bounties',
        parameters: [{ name: 'type', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'Open bounties', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Bounty' } } } } } },
      },
      post: {
        summary: 'Post a funded bounty (auth required)',
        description: 'Escrows the reward from the poster wallet. Verifiers claim and fulfill it.',
        security: [{ agentAuth: [], apiKey: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['type', 'subject', 'reward', 'postedBy'], properties: { type: { type: 'string' }, subject: { type: 'string' }, reward: { type: 'number' }, postedBy: { type: 'string' }, expiresInSeconds: { type: 'number' } } } } } },
        responses: { '201': { description: 'Bounty created' } },
      },
    },
    '/bounties/{id}/claim': {
      post: {
        summary: 'Claim a bounty (verifier, 10x stake required)',
        security: [{ agentAuth: [], apiKey: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['verifierId'], properties: { verifierId: { type: 'string' } } } } } },
        responses: { '200': { description: 'Bounty claimed' } },
      },
    },
    '/bounties/{id}/fulfill': {
      post: {
        summary: 'Fulfill a claimed bounty (signed attestation)',
        security: [{ agentAuth: [], apiKey: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['result', 'resultSummary', 'confidence', 'signature'], properties: { result: { type: 'string' }, resultSummary: { type: 'string' }, confidence: { type: 'number' }, signature: { type: 'string' } } } } } },
        responses: { '200': { description: 'Bounty fulfilled; attestation published' } },
      },
    },
    '/bounties/{id}/cancel': {
      post: {
        summary: 'Cancel an open bounty (poster only)',
        security: [{ agentAuth: [], apiKey: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['requestedBy'], properties: { requestedBy: { type: 'string' } } } } } },
        responses: { '200': { description: 'Bounty cancelled; escrow returned' } },
      },
    },
    '/verifiers': {
      get: { summary: 'List active verifiers', responses: { '200': { description: 'Verifier list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Verifier' } } } } } } },
      post: {
        summary: 'Register a verifier (auth required)',
        description: 'Omit publicKey to have the server generate an ed25519 keypair; the private key is returned once.',
        security: [{ agentAuth: [], apiKey: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'endpoint', 'initialStake'], properties: { name: { type: 'string' }, endpoint: { type: 'string' }, publicKey: { type: 'string' }, initialStake: { type: 'number' } } } } } },
        responses: { '201': { description: 'Verifier registered' } },
      },
    },
    '/verifiers/{id}': {
      get: { summary: 'Get a verifier', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Verifier' }, '404': { description: 'Not found' } } },
    },
    '/verifiers/{id}/attestations': {
      get: { summary: "List a verifier's attestations", parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Attestation list' } } },
    },
    '/verifiers/{id}/stake': {
      post: { summary: 'Add stake to a verifier (auth required)', security: [{ agentAuth: [], apiKey: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['amount'], properties: { amount: { type: 'number' } } } } } }, responses: { '200': { description: 'Stake added' } } },
    },
    '/wallets/{ownerId}': {
      get: { summary: 'Check a wallet balance', parameters: [{ name: 'ownerId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Wallet details' } } },
    },
    '/wallets/{ownerId}/deposit': {
      post: { summary: 'Create a Lightning deposit invoice (auth required)', security: [{ agentAuth: [], apiKey: [] }], parameters: [{ name: 'ownerId', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['amount', 'memo'], properties: { amount: { type: 'number' }, memo: { type: 'string' }, ownerType: { type: 'string' } } } } } }, responses: { '200': { description: 'BOLT11 invoice' } } },
    },
    '/wallets/deposit/confirm': {
      post: { summary: 'Confirm a Lightning deposit (auth required)', security: [{ agentAuth: [], apiKey: [] }], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['paymentHash'], properties: { paymentHash: { type: 'string' } } } } } }, responses: { '200': { description: 'Deposit result' } } },
    },
    '/wallets/{ownerId}/withdraw': {
      post: { summary: 'Withdraw to a Lightning invoice (auth required)', security: [{ agentAuth: [], apiKey: [] }], parameters: [{ name: 'ownerId', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['invoice', 'amount'], properties: { invoice: { type: 'string' }, amount: { type: 'number' } } } } } }, responses: { '200': { description: 'Withdrawal result' } } },
    },
    '/transactions': {
      get: { summary: 'List recent transactions', parameters: [{ name: 'limit', in: 'query', schema: { type: 'number', default: 50 } }], responses: { '200': { description: 'Transaction list' } } },
    },
    '/transactions/{buyerId}': {
      get: { summary: 'List a buyer\'s transactions', parameters: [{ name: 'buyerId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Transaction list' } } },
    },
    '/x402/info': {
      get: { summary: 'x402 payment configuration and gated route pricing', responses: { '200': { description: 'x402 status (never includes secrets)' } } },
    },
    '/stats': { get: { summary: 'Marketplace statistics', responses: { '200': { description: 'Stats' } } } },
    '/usage': { get: { summary: 'Usage report and activity feed', responses: { '200': { description: 'Usage report' } } } },
    '/me': { get: { summary: 'Current agent profile and wallet (auth required)', security: [{ agentAuth: [], apiKey: [] }], responses: { '200': { description: 'Agent profile' } } } },
    '/health': { get: { summary: 'Service health', responses: { '200': { description: 'Health status' } } } },
  },
};

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const agentId = req.headers['x-agent-id'] as string | undefined;
  const apiKey = req.headers['x-api-key'] as string | undefined;

  if (!agentId || !apiKey) {
    res.status(401).json({ error: 'Missing X-Agent-Id or X-Api-Key header. Create an account: POST /signup' });
    return;
  }

  // Use sync validation via janky pattern but Express middleware MUST be sync
  // We'll validate properly in the handler
  (req as AuthRequest).pendingAgent = { agentId, apiKey };
  next();
}

interface AuthRequest extends express.Request {
  agent?: { agentId: string; name: string; createdAt: string };
  pendingAgent?: { agentId: string; apiKey: string };
}

async function resolveAuth(req: express.Request): Promise<{ agentId: string; name: string }> {
  const ar = req as AuthRequest;
  if (ar.agent) return ar.agent;

  if (ar.pendingAgent) {
    const agent = await validateApiKeyAsync(ar.pendingAgent.agentId, ar.pendingAgent.apiKey);
    if (!agent) throw new Error('Invalid credentials');
    ar.agent = agent;
    return agent;
  }
  throw new Error('Not authenticated');
}

function assertOwner(agent: { agentId: string }, claimedId: string, role: string): void {
  if (agent.agentId !== claimedId) {
    throw new Error(`${role} must match authenticated agent (${agent.agentId}), got ${claimedId}`);
  }
}

export function createAPI(): express.Express {
  const app = express();
  app.set('trust proxy', true);
  app.use(cors());
  app.use(express.json());

  // Serve static discovery assets (e.g. /.well-known/agent.json).
  // dotfiles must be 'allow' or serve-static ignores .well-known by default.
  const publicDir = path.resolve(process.cwd(), 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, { dotfiles: 'allow' }));
  }

  app.use((req, res, next) => {
    res.on('finish', () => {
      logApiRequest(req.method, req.path, req.ip || req.socket.remoteAddress || 'unknown',
        req.headers['user-agent'] as string | undefined, res.statusCode);
    });
    next();
  });

  // --- x402 payment gate (disabled unless X402_ENABLED=true) ---
  // Mounted after express.json() and before any route handlers. Only the
  // routes in buildX402RouteConfig() are gated; everything else passes through.
  if (isX402Enabled()) {
    app.use(paymentMiddleware(buildX402RouteConfig(), getX402ResourceServer()));
  }

  // --- Public pages ---

  app.get('/', async (_req, res) => {
    try {
      await autoSeedDailyIfNeeded();
      const stats = await getMarketplaceStats();
      const usage = await getUsageReport();
      const bounties = await listOpenBounties(undefined, 100);
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.send(renderLanding(stats as unknown as Record<string, unknown>, usage as unknown as Record<string, unknown>, bounties.length));
    } catch (err) {
      res.status(500).send(String(err));
    }
  });

  app.get('/dashboard', async (req, res) => {
    try {
      const agentId = req.query.agentId as string | undefined;
      const apiKey = req.query.key as string | undefined;

      if (!agentId || !apiKey) {
        res.setHeader('Content-Type', 'text/html');
        res.send(renderLogin());
        return;
      }

      const agent = await validateApiKeyAsync(agentId, apiKey);
      if (!agent) {
        res.setHeader('Content-Type', 'text/html');
        res.send(renderLogin('Invalid credentials.'));
        return;
      }

      await autoSeedDailyIfNeeded();
      await onboardAgent(agentId);
      const wallet = await getWallet(agentId);
      const stats = await getMarketplaceStats();
      const openBounties = await listOpenBounties(undefined, 50);
      const myBounties = await getBountiesByPoster(agentId);
      const myTxns = await getBuyerHistory(agentId);
      const myVerifier = await getVerifier(agentId);
      const verifiers = await listVerifiers(true);

      res.setHeader('Content-Type', 'text/html');
      res.send(renderDashboard({
        agent, apiKey,
        wallet: wallet ? { balance: wallet.balance, ownerType: wallet.ownerType as 'verifier' | 'buyer' } : { balance: 0, ownerType: 'buyer' as const },
        stats: stats as unknown as Record<string, unknown>,
        openBounties: openBounties.length,
        bounties: openBounties.slice(0, 20),
        myBounties: myBounties.slice(0, 20),
        myTxns: myTxns.slice(0, 20),
        myVerifier,
        verifiers: verifiers.slice(0, 20),
      }));
    } catch (err) {
      res.status(500).send(String(err));
    }
  });

  // --- API specs ---

  app.get('/openapi.json', (_req, res) => { res.json(OPENAPI_SPEC); });
  app.get('/health', (_req, res) => { res.json({ status: 'ok', protocol: 'factorium', version: '1.0.7', mcp: '/mcp' }); });

  // x402 payment configuration discovery (public; never includes secrets)
  app.get('/x402/info', (_req, res) => { res.json(getX402Info()); });

  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain');
    res.send('User-agent: *\nAllow: /\nSitemap: https://factorium.network/sitemap.xml\n');
  });

  app.get('/sitemap.xml', (_req, res) => {
    const urls = [{ loc: 'https://factorium.network', priority: '1.0' }, { loc: 'https://factorium.network/dashboard', priority: '0.8' }, { loc: 'https://factorium.network/openapi.json', priority: '0.6' }];
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    for (const u of urls) xml += `  <url><loc>${u.loc}</loc><priority>${u.priority}</priority></url>\n`;
    xml += '</urlset>';
    res.type('application/xml');
    res.send(xml);
  });

  // --- MCP Server ---

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    try {
      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req, res, req.body);
        return;
      }
      if (!sessionId && isInitializeRequest(req.body)) {
        const transport = createMCPHttpTransport();
        transport.onclose = () => { const sid = transport.sessionId; if (sid) transports.delete(sid); };
        await createAndConnectMCPTransport(transport);
        await transport.handleRequest(req, res, req.body);
        // Register the new session so follow-up requests can find it.
        // (Without this, every post-initialize request returns 400.)
        if (transport.sessionId) transports.set(transport.sessionId, transport);
        return;
      }
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request' }, id: null });
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) { res.status(400).json({ error: 'Invalid or missing session ID' }); return; }
    await transports.get(sessionId)!.handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) { res.status(400).json({ error: 'Invalid or missing session ID' }); return; }
    await transports.get(sessionId)!.handleRequest(req, res);
  });

  // --- Auth endpoints ---

  app.post('/signup', async (req, res) => {
    try {
      const { name } = SignupSchema.parse(req.body);
      const { agentId, apiKey } = await generateApiKey(name);
      await onboardAgent(agentId);
      await logActivity('agent_signup', `Agent ${name} (${agentId}) created`, agentId);
      res.status(201).json({
        agentId, apiKey, name,
        message: 'Agent account created. Save your API key.',
        nextSteps: [`Dashboard: /dashboard?agentId=${agentId}&key=${apiKey}`, 'Check balance: GET /wallets/' + agentId],
      });
    } catch (err) { res.status(400).json({ error: String(err) }); }
  });

  app.get('/me', requireAuth, async (req, res) => {
    try {
      const agent = await resolveAuth(req);
      const wallet = await getWallet(agent.agentId);
      const bounties = await getBountiesByPoster(agent.agentId);
      const txns = await getBuyerHistory(agent.agentId);
      const verifier = await getVerifier(agent.agentId);
      res.json({ agent, wallet: wallet ? { balance: wallet.balance } : null, bountiesPosted: bounties.length, transactions: txns.length, isVerifier: !!verifier, verifier });
    } catch (err) { res.status(401).json({ error: String(err) }); }
  });

  app.get('/usage', async (_req, res) => {
    try { await autoSeedDailyIfNeeded(); res.json(await getUsageReport()); } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  app.get('/stats', async (_req, res) => {
    try { await autoSeedDailyIfNeeded(); res.json(await getMarketplaceStats()); } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  app.get('/welcome/:agentId', async (req, res) => {
    const onboarded = await onboardAgent(req.params.agentId as string);
    const wallet = await getWallet(req.params.agentId as string);
    res.json({ welcome: 'Welcome to Factorium', balance: wallet?.balance ?? 0, isNew: onboarded, agentId: req.params.agentId });
  });

  // --- Attestations ---

  app.get('/attestations', async (req, res) => {
    try {
      const validated = AttestationQuerySchema.parse(req.query);
      await autoSeedDailyIfNeeded();
      const result = await queryAttestations(validated);
      if (result.total === 0) {
        const bounties = await listOpenBounties(validated.type as any, 5);
        res.json({ ...result, message: 'No attestations found. Post a bounty.', openBounties: bounties.length });
        return;
      }
      res.json(result);
    } catch (err) { res.status(400).json({ error: String(err) }); }
  });

  app.get('/attestations/:id', async (req, res) => {
    const a = await getAttestation(req.params.id as string);
    if (!a) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(a);
  });

  app.get('/attestations/:id/verify', async (req, res) => {
    try {
      const a = await getAttestation(req.params.id as string);
      if (!a) { res.status(404).json({ error: 'Not found' }); return; }
      const verifier = await getVerifier(a.verifierId);

      if (a.verifierSignature.startsWith('sig:')) {
        res.json({ attestationId: a.id, verifierId: a.verifierId, signatureValid: false, verifierPublicKey: verifier?.publicKey ?? null, reason: 'legacy-unsigned' });
        return;
      }
      if (!verifier) {
        res.json({ attestationId: a.id, verifierId: a.verifierId, signatureValid: false, verifierPublicKey: null, reason: 'verifier-not-found' });
        return;
      }

      const payload = canonicalAttestationPayload({
        type: a.type, subjectHash: a.subjectHash, result: a.result,
        confidence: a.confidence, price: a.price, verifierId: a.verifierId,
      });
      const valid = verifyPayload(verifier.publicKey, payload, a.verifierSignature);
      res.json({ attestationId: a.id, verifierId: a.verifierId, signatureValid: valid, verifierPublicKey: verifier.publicKey, reason: valid ? 'ok' : 'signature-mismatch' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  app.post('/attestations', requireAuth, async (req, res) => {
    try {
      const agent = await resolveAuth(req);
      const validated = AttestationSubmissionSchema.parse(req.body);
      assertOwner(agent, validated.verifierId, 'verifierId');
      const verifier = await getVerifier(validated.verifierId);
      if (!verifier) { res.status(404).json({ error: 'Register as verifier first: POST /verifiers' }); return; }
      if (!verifier.active) { res.status(403).json({ error: 'Verifier inactive' }); return; }
      if (verifier.stakedAmount < validated.price * 10) {
        res.status(403).json({ error: `Insufficient stake. Need ${validated.price * 10}, have ${verifier.stakedAmount}.` });
        return;
      }
      const payload = canonicalAttestationPayload({
        type: validated.type, subjectHash: hashSubject(validated.subject), result: validated.result,
        confidence: validated.confidence, price: validated.price, verifierId: agent.agentId,
      });
      if (!verifyPayload(verifier.publicKey, payload, validated.signature)) {
        res.status(403).json({ error: 'Invalid signature. Sign the canonical attestation payload with your verifier private key.' });
        return;
      }
      const attestation = await submitAttestation({ ...validated, verifierId: agent.agentId });
      await logActivity('attestation_submitted', `${attestation.type}: ${attestation.resultSummary.slice(0, 80)}`, agent.agentId);
      res.status(201).json(attestation);
    } catch (err) { res.status(400).json({ error: String(err) }); }
  });

  // When x402 is enabled, the paymentMiddleware gate collects payment up front
  // and the onAfterSettle hook records the ledger split — so this handler skips
  // both auth (the payer's settled address is the buyer identity) and the
  // internal purchaseAttestation() money movement. When disabled, the legacy
  // internal-wallet path runs unchanged.
  app.post('/attestations/:id/purchase', ...(isX402Enabled() ? [] : [requireAuth]), async (req, res) => {
    try {
      if (isX402Enabled()) {
        const attestation = await getAttestation(req.params.id as string);
        if (!attestation) { res.status(404).json({ error: 'Not found' }); return; }
        await logActivity('attestation_purchased_x402', `x402 purchase of attestation ${attestation.id} (${attestation.price} cents USD)`);
        res.json({ attestation, payment: 'x402' });
        return;
      }
      const agent = await resolveAuth(req);
      const { buyerId } = req.body;
      if (!buyerId) { res.status(400).json({ error: 'buyerId required' }); return; }
      assertOwner(agent, buyerId, 'buyerId');
      await onboardAgent(agent.agentId);
      const result = await purchaseAttestation(req.params.id as string, agent.agentId);
      await logActivity('attestation_purchased', `Buyer paid ${result.attestation.price} sats`, agent.agentId);
      res.json(result);
    } catch (err) { res.status(400).json({ error: String(err) }); }
  });

  app.post('/attestations/:id/dispute', requireAuth, async (req, res) => {
    try {
      const validated = DisputeSchema.parse({ attestationId: req.params.id, ...req.body });
      const updated = await disputeAttestation(validated.attestationId, validated.reason);
      res.json(updated);
    } catch (err) { res.status(400).json({ error: String(err) }); }
  });

  // --- Bounties ---

  app.get('/bounties', async (req, res) => {
    const type = req.query.type as string | undefined;
    res.json(await listOpenBounties(type as any));
  });

  app.post('/bounties', requireAuth, async (req, res) => {
    try {
      const agent = await resolveAuth(req);
      const { type, subject, reward, postedBy, expiresInSeconds } = req.body;
      if (!type || !subject || !reward || !postedBy) { res.status(400).json({ error: 'type, subject, reward, postedBy required' }); return; }
      assertOwner(agent, postedBy, 'postedBy');
      await onboardAgent(agent.agentId);
      // When x402 is enabled the reward was charged at the payment gate, so
      // postBounty skips the internal-wallet debit but still escrows the reward.
      const bounty = await postBounty({ type, subject, subjectHash: hashSubject(subject), reward, postedBy: agent.agentId, expiresInSeconds, fundedExternally: isX402Enabled() });
      await logActivity('bounty_posted', `${type}: ${subject.slice(0, 60)} (${reward} sats)`, agent.agentId);
      res.status(201).json(bounty);
    } catch (err) { res.status(400).json({ error: String(err) }); }
  });

  app.get('/bounties/:id', async (req, res) => {
    const b = await getBounty(req.params.id as string);
    if (!b) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(b);
  });

  app.post('/bounties/:id/claim', requireAuth, async (req, res) => {
    try {
      const agent = await resolveAuth(req);
      const { verifierId } = req.body;
      if (!verifierId) { res.status(400).json({ error: 'verifierId required' }); return; }
      assertOwner(agent, verifierId, 'verifierId');
      const bounty = await claimBounty(req.params.id as string, agent.agentId);
      await logActivity('bounty_claimed', `Bounty claimed by ${agent.agentId.slice(0, 8)}`, agent.agentId);
      res.json(bounty);
    } catch (err) { res.status(400).json({ error: String(err) }); }
  });

  app.post('/bounties/:id/fulfill', requireAuth, async (req, res) => {
    try {
      await resolveAuth(req);
      const { result, resultSummary, confidence, signature } = req.body;
      if (!result || !resultSummary || confidence === undefined || !signature) { res.status(400).json({ error: 'result, resultSummary, confidence, signature required' }); return; }
      const fulfilled = await fulfillBounty(req.params.id as string, result, resultSummary, confidence, signature);
      await logActivity('bounty_fulfilled', `Bounty fulfilled: ${resultSummary.slice(0, 60)}`);
      res.json(fulfilled);
    } catch (err) { res.status(400).json({ error: String(err) }); }
  });

  app.post('/bounties/:id/cancel', requireAuth, async (req, res) => {
    try {
      const agent = await resolveAuth(req);
      const { requestedBy } = req.body;
      if (!requestedBy) { res.status(400).json({ error: 'requestedBy required' }); return; }
      assertOwner(agent, requestedBy, 'requestedBy');
      const bounty = await cancelBounty(req.params.id as string, agent.agentId);
      res.json(bounty);
    } catch (err) { res.status(400).json({ error: String(err) }); }
  });

  app.get('/bounties/poster/:posterId', async (req, res) => {
    res.json(await getBountiesByPoster(req.params.posterId as string));
  });

  // --- Verifiers ---

  app.get('/verifiers', async (_req, res) => { res.json(await listVerifiers(true)); });
  app.get('/verifiers/top', async (req, res) => { res.json(await getTopVerifiers(Number(req.query.limit) || 10)); });

  app.get('/verifiers/:id', async (req, res) => {
    const v = await getVerifier(req.params.id as string);
    if (!v) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(v);
  });

  app.post('/verifiers', requireAuth, async (req, res) => {
    try {
      const agent = await resolveAuth(req);
      const validated = VerifierRegistrationSchema.parse(req.body);
      await onboardAgent(agent.agentId);
      const verifier = await registerVerifier({ ...validated, id: agent.agentId });
      await logActivity('verifier_registered', `${validated.name} registered with ${validated.initialStake} stake`, agent.agentId);
      if (verifier.privateKeyPem) {
        res.status(201).json({ ...verifier, warning: 'Save this private key now. It will never be shown again.' });
        return;
      }
      res.status(201).json(verifier);
    } catch (err) { res.status(400).json({ error: String(err) }); }
  });

  app.get('/verifiers/:id/attestations', async (req, res) => {
    const v = await getVerifier(req.params.id as string);
    if (!v) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(await getAttestationsByVerifier(req.params.id as string));
  });

  app.get('/verifiers/:id/staking-history', async (req, res) => {
    const v = await getVerifier(req.params.id as string);
    if (!v) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(await getStakingHistory(req.params.id as string));
  });

  app.post('/verifiers/:id/stake', requireAuth, async (req, res) => {
    try {
      const agent = await resolveAuth(req);
      assertOwner(agent, req.params.id as string, 'verifierId');
      res.json(await stake(agent.agentId, req.body.amount));
    } catch (err) { res.status(400).json({ error: String(err) }); }
  });

  // NOTE: admin-only verifier slashing and reputation adjustment are
  // intentionally NOT exposed over the public REST API. The previous routes
  // only required any valid agent key, so any authenticated agent could slash
  // or reputate any verifier. The underlying functions remain for internal
  // use (e.g. dispute penalties) and can be re-exposed behind an admin
  // credential later.

  // --- Transactions ---

  app.get('/transactions', async (req, res) => { res.json(await getRecentTransactions(Number(req.query.limit) || 50)); });
  app.get('/transactions/:buyerId', async (req, res) => { res.json(await getBuyerHistory(req.params.buyerId as string)); });

  // --- Utility ---

  app.post('/hash', (req, res) => {
    const { subject } = req.body;
    if (!subject) { res.status(400).json({ error: 'subject required' }); return; }
    res.json({ subject, hash: hashSubject(subject) });
  });

  // --- Payments ---

  app.get('/wallets/:ownerId', async (req, res) => {
    const wallet = await getWallet(req.params.ownerId as string);
    if (!wallet) {
      const w = await getOrCreateWallet(req.params.ownerId as string, 'buyer');
      res.json({ ownerId: req.params.ownerId, balance: w.balance, lightningConfigured: isLightningConfigured() });
      return;
    }
    res.json({ ownerId: wallet.ownerId, ownerType: wallet.ownerType, balance: wallet.balance, lightningConfigured: isLightningConfigured() });
  });

  app.post('/wallets/:ownerId/deposit', requireAuth, async (req, res) => {
    try {
      const agent = await resolveAuth(req);
      assertOwner(agent, req.params.ownerId as string, 'ownerId');
      const { amount, memo, ownerType } = req.body;
      if (!amount || !memo) { res.status(400).json({ error: 'amount and memo required' }); return; }
      const invoice = await createDepositInvoice(agent.agentId, ownerType || 'buyer', amount, memo);
      res.json({ invoice, instructions: 'Pay this BOLT11 invoice, then POST /wallets/deposit/confirm' });
    } catch (err) { res.status(400).json({ error: String(err) }); }
  });

  app.post('/wallets/deposit/confirm', requireAuth, async (req, res) => {
    try {
      const { paymentHash } = req.body;
      if (!paymentHash) { res.status(400).json({ error: 'paymentHash required' }); return; }
      res.json(await confirmDeposit(paymentHash));
    } catch (err) { res.status(400).json({ error: String(err) }); }
  });

  app.post('/wallets/:ownerId/withdraw', requireAuth, async (req, res) => {
    try {
      const agent = await resolveAuth(req);
      assertOwner(agent, req.params.ownerId as string, 'ownerId');
      const { invoice, amount } = req.body;
      if (!invoice || !amount) { res.status(400).json({ error: 'invoice and amount required' }); return; }
      res.json(await withdrawFunds(agent.agentId, invoice, amount));
    } catch (err) { res.status(400).json({ error: String(err) }); }
  });

  return app;
}

export function startAPI(port = 3099): void {
  const app = createAPI();
  app.listen(port, () => {
    console.log(`Factorium — Attestation Marketplace Protocol`);
    console.log(`Running on http://localhost:${port}`);
  });
}
