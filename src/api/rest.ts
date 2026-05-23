import express from 'express';
import cors from 'cors';
import {
  submitAttestation,
  queryAttestations,
  purchaseAttestation,
  getAttestation,
  disputeAttestation,
  hashSubject,
  getAttestationsByVerifier,
} from '../registry/attestations.js';
import {
  registerVerifier,
  getVerifier,
  listVerifiers,
  stake,
  slash,
  updateReputation,
  getTopVerifiers,
  getStakingHistory,
} from '../registry/verifiers.js';
import {
  getMarketplaceStats,
  getRecentTransactions,
  getBuyerHistory,
} from '../marketplace/marketplace.js';
import {
  AttestationSubmissionSchema,
  VerifierRegistrationSchema,
  AttestationQuerySchema,
  DisputeSchema,
  SignupSchema,
} from '../types/index.js';
import {
  getOrCreateWallet,
  getWallet,
  createDepositInvoice,
  confirmDeposit,
  withdrawFunds,
  fundWalletDirectly,
} from '../payments/wallets.js';
import { isLightningConfigured } from '../payments/provider.js';
import { logApiRequest, logActivity, getUsageReport } from '../monitoring/usage.js';
import { autoSeedDailyIfNeeded } from '../scheduler/auto-seed.js';
import { onboardAgent, getOnboardingMessage } from '../onboarding/agent-onboard.js';
import {
  postBounty,
  getBounty,
  listOpenBounties,
  claimBounty,
  fulfillBounty,
  cancelBounty,
  getBountiesByPoster,
} from '../bounties/bounty-market.js';
import { generateApiKey, validateApiKey } from '../auth/keys.js';
import { renderLanding, renderDashboard, renderLogin } from '../dashboard/html.js';
import { getOrCreateMCPServer, createMCPHttpTransport, createAndConnectMCPTransport } from '../mcp/server.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Factorium — Attestation Marketplace Protocol',
    description: 'Decentralized marketplace where AI systems buy and sell verified attestations. Eliminate redundant compute. Buyers query pre-computed verification results. Verifiers earn on every query. 10% marketplace fee. 10x stake requirement.',
    version: '1.0.7',
    contact: { name: 'Factorium', url: 'https://factorium.network' },
  },
  servers: [{ url: 'https://factorium.network', description: 'Production' }],
  paths: {
    '/signup': { post: { summary: 'Create an agent account', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } }, responses: { '201': { description: 'Agent created with API key' } } } },
    '/attestations': {
      get: { summary: 'Query attestations', parameters: [{ name: 'type', in: 'query', schema: { type: 'string' } }, { name: 'subject', in: 'query', schema: { type: 'string' } }, { name: 'minConfidence', in: 'query', schema: { type: 'number' } }, { name: 'maxPrice', in: 'query', schema: { type: 'number' } }], responses: { '200': { description: 'Attestation query results' } } },
      post: { summary: 'Submit new attestation (auth required)', requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '201': { description: 'Attestation created' } } },
    },
    '/bounties': {
      get: { summary: 'List open bounties', parameters: [{ name: 'type', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'Open bounties' } } },
      post: { summary: 'Post a funded verification bounty (auth required)', requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '201': { description: 'Bounty created' } } },
    },
    '/verifiers': { get: { summary: 'List active verifiers', responses: { '200': { description: 'Verifier list' } } }, post: { summary: 'Register as verifier (auth required)', responses: { '201': { description: 'Verifier created' } } } },
    '/wallets/{ownerId}': { get: { summary: 'Check wallet balance', parameters: [{ name: 'ownerId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Wallet details' } } } },
    '/stats': { get: { summary: 'Marketplace statistics', responses: { '200': { description: 'Stats' } } } },
    '/usage': { get: { summary: 'Usage report and activity feed', responses: { '200': { description: 'Usage report' } } } },
    '/openapi.json': { get: { summary: 'OpenAPI spec for agent discovery', responses: { '200': { description: 'OpenAPI 3.0 spec' } } } },
  },
};

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const agentId = req.headers['x-agent-id'] as string | undefined;
  const apiKey = req.headers['x-api-key'] as string | undefined;

  if (!agentId || !apiKey) {
    res.status(401).json({ error: 'Missing X-Agent-Id or X-Api-Key header. Create an account: POST /signup' });
    return;
  }

  const agent = validateApiKey(agentId, apiKey);
  if (!agent) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  (req as AuthRequest).agent = agent;
  next();
}

interface AuthRequest extends express.Request {
  agent?: { agentId: string; name: string; createdAt: string };
}

function authAgent(req: express.Request): { agentId: string; name: string } {
  const agent = (req as AuthRequest).agent;
  if (!agent) throw new Error('Not authenticated');
  return agent;
}

function assertOwner(req: express.Request, claimedId: string, role: string): void {
  const agent = authAgent(req);
  if (agent.agentId !== claimedId) {
    throw new Error(`${role} must match authenticated agent (${agent.agentId}), got ${claimedId}`);
  }
}

export function createAPI(): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use((req, res, next) => {
    res.on('finish', () => {
      logApiRequest(
        req.method,
        req.path,
        req.ip || req.socket.remoteAddress || 'unknown',
        req.headers['user-agent'],
        res.statusCode
      );
    });
    next();
  });

  // --- Public pages ---

  app.get('/', (_req, res) => {
    autoSeedDailyIfNeeded();
    const stats = getMarketplaceStats();
    const usage = getUsageReport();
    const openBounties = listOpenBounties(undefined, 100);
    res.setHeader('Content-Type', 'text/html');
    res.send(renderLanding(
      stats as unknown as Record<string, unknown>,
      usage as unknown as Record<string, unknown>,
      openBounties.length
    ));
  });

  app.get('/dashboard', (req, res) => {
    const agentId = req.query.agentId as string | undefined;
    const apiKey = req.query.key as string | undefined;

    if (!agentId || !apiKey) {
      res.setHeader('Content-Type', 'text/html');
      res.send(renderLogin());
      return;
    }

    const agent = validateApiKey(agentId, apiKey);
    if (!agent) {
      res.setHeader('Content-Type', 'text/html');
      res.send(renderLogin('Invalid credentials. Check your Agent ID and API Key.'));
      return;
    }

    autoSeedDailyIfNeeded();
    onboardAgent(agentId, 'buyer');
    const wallet = getWallet(agentId);
    const stats = getMarketplaceStats();
    const openBounties = listOpenBounties(undefined, 50);
    const myBounties = getBountiesByPoster(agentId);
    const myTxns = getBuyerHistory(agentId);
    const myVerifier = getVerifier(agentId);
    const verifiers = listVerifiers(true);

    res.setHeader('Content-Type', 'text/html');
    res.send(renderDashboard({
      agent,
      apiKey,
      wallet: wallet ? { balance: wallet.balance, ownerType: wallet.ownerType } : { balance: 0, ownerType: 'buyer' as const },
      stats: stats as unknown as Record<string, unknown>,
      openBounties: openBounties.length,
      bounties: openBounties.slice(0, 20),
      myBounties: myBounties.slice(0, 20),
      myTxns: myTxns.slice(0, 20),
      myVerifier,
      verifiers: verifiers.slice(0, 20),
    }));
  });

  // --- API specs ---

  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain');
    res.send('User-agent: *\nAllow: /\nSitemap: https://factorium.network/sitemap.xml\n');
  });

  app.get('/sitemap.xml', (_req, res) => {
    const urls = [
      { loc: 'https://factorium.network', priority: '1.0' },
      { loc: 'https://factorium.network/dashboard', priority: '0.8' },
      { loc: 'https://factorium.network/openapi.json', priority: '0.6' },
    ];
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    for (const u of urls) {
      xml += `  <url><loc>${u.loc}</loc><priority>${u.priority}</priority></url>\n`;
    }
    xml += '</urlset>';
    res.type('application/xml');
    res.send(xml);
  });

  app.get('/openapi.json', (_req, res) => {
    res.json(OPENAPI_SPEC);
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', protocol: 'factorium', version: '1.0.7', mcp: '/mcp' });
  });

  // --- MCP Server (AI agent interface) ---

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = createMCPHttpTransport();
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) transports.delete(sid);
        };
        await createAndConnectMCPTransport(transport);
      } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID or not an initialization request' }, id: null });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // --- Auth endpoints ---

  app.post('/signup', (req, res) => {
    try {
      const { name } = SignupSchema.parse(req.body);
      const { agentId, apiKey } = generateApiKey(name);
      onboardAgent(agentId, 'buyer');
      logActivity('agent_signup', `Agent ${name} (${agentId}) created`, agentId);
      res.status(201).json({
        agentId,
        apiKey,
        name,
        message: 'Agent account created. Save your API key — it will not be shown again. You have 1,000 free credits.',
        nextSteps: [
          `Dashboard: /dashboard?agentId=${agentId}&key=${apiKey}`,
          'Query attestations: GET /attestations?type=fact-check',
          'Post a bounty: POST /bounties',
          'Check balance: GET /wallets/' + agentId,
        ],
      });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/me', requireAuth, (req, res) => {
    const agent = authAgent(req);
    const wallet = getWallet(agent.agentId);
    const bounties = getBountiesByPoster(agent.agentId);
    const txns = getBuyerHistory(agent.agentId);
    const verifier = getVerifier(agent.agentId);
    res.json({
      agent,
      wallet: wallet ? { balance: wallet.balance, ownerType: wallet.ownerType } : null,
      bountiesPosted: bounties.length,
      transactions: txns.length,
      isVerifier: !!verifier,
      verifier,
    });
  });

  app.get('/usage', (_req, res) => {
    autoSeedDailyIfNeeded();
    res.json(getUsageReport());
  });

  app.get('/stats', (_req, res) => {
    autoSeedDailyIfNeeded();
    res.json(getMarketplaceStats());
  });

  app.get('/welcome/:agentId', (req, res) => {
    const onboarded = onboardAgent(req.params.agentId, 'buyer');
    const msg = getOnboardingMessage(req.params.agentId);
    res.json({
      ...msg,
      isNew: onboarded.isNew,
      agentId: req.params.agentId,
    });
  });

  // --- Attestations (query is public, write requires auth) ---

  app.get('/attestations', (req, res) => {
    try {
      const validated = AttestationQuerySchema.parse(req.query);
      autoSeedDailyIfNeeded();

      if (validated.verifierId) {
        onboardAgent(validated.verifierId, 'buyer');
      }

      const result = queryAttestations(validated);

      if (result.total === 0) {
        res.json({
          ...result,
          message: 'No attestations found. Post a bounty to fund verification: POST /bounties (auth required)',
          openBounties: listOpenBounties(validated.type, 5).length,
        });
        return;
      }

      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/attestations/:id', (req, res) => {
    const a = getAttestation(req.params.id);
    if (!a) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(a);
  });

  app.post('/attestations', requireAuth, (req, res) => {
    try {
      const agent = authAgent(req);
      const validated = AttestationSubmissionSchema.parse(req.body);
      assertOwner(req, validated.verifierId, 'verifierId');

      const verifier = getVerifier(validated.verifierId);
      if (!verifier) {
        res.status(404).json({ error: `Verifier not found: ${validated.verifierId}. Register first: POST /verifiers` });
        return;
      }
      if (!verifier.active) {
        res.status(403).json({ error: `Verifier is inactive: ${validated.verifierId}` });
        return;
      }
      if (verifier.stakedAmount < validated.price * 10) {
        res.status(403).json({
          error: `Insufficient stake. Need ${validated.price * 10} (10x price). Have ${verifier.stakedAmount}. Stake more: POST /verifiers/${validated.verifierId}/stake`,
        });
        return;
      }
      const attestation = submitAttestation({ ...validated, verifierId: agent.agentId });
      logActivity('attestation_submitted', `${attestation.type}: ${attestation.resultSummary.slice(0, 80)}`, agent.agentId);
      res.status(201).json(attestation);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.post('/attestations/:id/purchase', requireAuth, (req, res) => {
    try {
      const agent = authAgent(req);
      const { buyerId } = req.body;
      if (!buyerId) {
        res.status(400).json({ error: 'buyerId required' });
        return;
      }
      assertOwner(req, buyerId, 'buyerId');
      onboardAgent(agent.agentId, 'buyer');
      const result = purchaseAttestation(req.params.id as string, agent.agentId);
      logActivity('attestation_purchased', `Buyer ${agent.agentId.slice(0, 8)} paid ${result.attestation.price} sats for ${result.attestation.type}`, agent.agentId);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.post('/attestations/:id/dispute', requireAuth, (req, res) => {
    try {
      const validated = DisputeSchema.parse({
        attestationId: req.params.id,
        ...req.body,
      });
      const updated = disputeAttestation(validated.attestationId, validated.reason);
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // --- Bounties (read is public, write requires auth) ---

  app.get('/bounties', (req, res) => {
    const type = req.query.type as string | undefined;
    res.json(listOpenBounties(type as any));
  });

  app.post('/bounties', requireAuth, (req, res) => {
    try {
      const agent = authAgent(req);
      const { type, subject, reward, postedBy, expiresInSeconds } = req.body;
      if (!type || !subject || !reward || !postedBy) {
        res.status(400).json({ error: 'type, subject, reward, and postedBy required' });
        return;
      }
      assertOwner(req, postedBy, 'postedBy');
      onboardAgent(agent.agentId, 'buyer');
      const subjectHash = hashSubject(subject);
      const bounty = postBounty({ type, subject, subjectHash, reward, postedBy: agent.agentId, expiresInSeconds });
      logActivity('bounty_posted', `${type}: ${subject.slice(0, 60)} (${reward} sats)`, agent.agentId);
      res.status(201).json(bounty);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/bounties/:id', (req, res) => {
    const b = getBounty(req.params.id);
    if (!b) {
      res.status(404).json({ error: 'Bounty not found' });
      return;
    }
    res.json(b);
  });

  app.post('/bounties/:id/claim', requireAuth, (req, res) => {
    try {
      const agent = authAgent(req);
      const { verifierId } = req.body;
      if (!verifierId) {
        res.status(400).json({ error: 'verifierId required' });
        return;
      }
      assertOwner(req, verifierId, 'verifierId');
      const bounty = claimBounty(req.params.id as string, agent.agentId);
      logActivity('bounty_claimed', `Bounty ${(req.params.id as string).slice(0, 8)} claimed by ${agent.agentId.slice(0, 8)}`, agent.agentId);
      res.json(bounty);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.post('/bounties/:id/fulfill', requireAuth, (req, res) => {
    try {
      const agent = authAgent(req);
      const { result, resultSummary, confidence } = req.body;
      if (!result || !resultSummary || confidence === undefined) {
        res.status(400).json({ error: 'result, resultSummary, and confidence required' });
        return;
      }
      const fulfilled = fulfillBounty(req.params.id as string, result, resultSummary, confidence);
      logActivity('bounty_fulfilled', `Bounty fulfilled: ${resultSummary.slice(0, 60)}`, agent.agentId);
      res.json(fulfilled);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.post('/bounties/:id/cancel', requireAuth, (req, res) => {
    try {
      const agent = authAgent(req);
      const { requestedBy } = req.body;
      if (!requestedBy) {
        res.status(400).json({ error: 'requestedBy required' });
        return;
      }
      assertOwner(req, requestedBy, 'requestedBy');
      const bounty = cancelBounty(req.params.id as string, agent.agentId);
      res.json(bounty);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/bounties/poster/:posterId', (req, res) => {
    res.json(getBountiesByPoster(req.params.posterId));
  });

  // --- Verifiers (read is public, registration requires auth) ---

  app.get('/verifiers', (_req, res) => {
    res.json(listVerifiers(true));
  });

  app.get('/verifiers/top', (req, res) => {
    const limit = Number(req.query.limit) || 10;
    res.json(getTopVerifiers(limit));
  });

  app.get('/verifiers/:id', (req, res) => {
    const v = getVerifier(req.params.id);
    if (!v) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(v);
  });

  app.post('/verifiers', requireAuth, (req, res) => {
    try {
      const agent = authAgent(req);
      const validated = VerifierRegistrationSchema.parse(req.body);
      onboardAgent(agent.agentId, 'verifier');
      const verifier = registerVerifier({ ...validated, id: agent.agentId });
      logActivity('verifier_registered', `${validated.name} registered with ${validated.initialStake} stake`, agent.agentId);
      res.status(201).json(verifier);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/verifiers/:id/attestations', (req, res) => {
    const v = getVerifier(req.params.id);
    if (!v) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(getAttestationsByVerifier(req.params.id));
  });

  app.get('/verifiers/:id/staking-history', (req, res) => {
    const v = getVerifier(req.params.id);
    if (!v) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(getStakingHistory(req.params.id));
  });

  app.post('/verifiers/:id/stake', requireAuth, (req, res) => {
    try {
      const agent = authAgent(req);
      assertOwner(req, req.params.id as string, 'verifierId');
      const { amount } = req.body;
      const v = stake(agent.agentId, amount);
      res.json(v);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.post('/verifiers/:id/slash', requireAuth, (req, res) => {
    try {
      const { amount, reason } = req.body;
      const v = slash(req.params.id as string, amount, reason);
      res.json(v);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.post('/verifiers/:id/reputation', requireAuth, (req, res) => {
    try {
      const { delta } = req.body;
      const v = updateReputation(req.params.id as string, delta);
      res.json(v);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // --- Transactions ---

  app.get('/transactions', (req, res) => {
    const limit = Number(req.query.limit) || 50;
    res.json(getRecentTransactions(limit));
  });

  app.get('/transactions/:buyerId', (req, res) => {
    res.json(getBuyerHistory(req.params.buyerId));
  });

  // --- Utility ---

  app.post('/hash', (req, res) => {
    const { subject } = req.body;
    if (!subject) {
      res.status(400).json({ error: 'subject required' });
      return;
    }
    res.json({ subject, hash: hashSubject(subject) });
  });

  // --- Payments (wallet read is public, write requires auth) ---

  app.get('/wallets/:ownerId', (req, res) => {
    const wallet = getWallet(req.params.ownerId);
    if (!wallet) {
      getOrCreateWallet(req.params.ownerId, 'buyer');
      res.json({ ownerId: req.params.ownerId, balance: 0, lightningConfigured: isLightningConfigured() });
      return;
    }
    res.json({
      ownerId: wallet.ownerId,
      ownerType: wallet.ownerType,
      balance: wallet.balance,
      lightningConfigured: isLightningConfigured(),
      hasLNBitsWallet: !!wallet.lnbitsWalletId,
    });
  });

  app.post('/wallets/:ownerId/deposit', requireAuth, async (req, res) => {
    try {
      const agent = authAgent(req);
      assertOwner(req, req.params.ownerId as string, 'ownerId');
      const { amount, memo, ownerType } = req.body;
      if (!amount || !memo) {
        res.status(400).json({ error: 'amount and memo required' });
        return;
      }
      const invoice = await createDepositInvoice(
        agent.agentId,
        ownerType || 'buyer',
        amount,
        memo
      );
      res.json({ invoice, instructions: 'Pay this BOLT11 invoice, then POST /wallets/deposit/confirm' });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.post('/wallets/deposit/confirm', requireAuth, async (req, res) => {
    try {
      const { paymentHash } = req.body;
      if (!paymentHash) {
        res.status(400).json({ error: 'paymentHash required' });
        return;
      }
      const result = await confirmDeposit(paymentHash);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.post('/wallets/:ownerId/withdraw', requireAuth, async (req, res) => {
    try {
      const agent = authAgent(req);
      assertOwner(req, req.params.ownerId as string, 'ownerId');
      const { invoice, amount } = req.body;
      if (!invoice || !amount) {
        res.status(400).json({ error: 'invoice and amount required' });
        return;
      }
      const result = await withdrawFunds(agent.agentId, invoice, amount);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  return app;
}

export function startAPI(port = 3099): void {
  const app = createAPI();
  app.listen(port, () => {
    console.log(`Factorium — Attestation Marketplace Protocol`);
    console.log(`Running on http://localhost:${port}`);
    console.log(`  GET  /                           Landing page (sign up to get started)`);
    console.log(`  GET  /dashboard?agentId=X&key=Y  Your dashboard`);
    console.log(`  POST /signup                     Create agent account`);
    console.log(`  GET  /me                         Agent profile (auth required)`);
    console.log(`  GET  /openapi.json               OpenAPI spec for agent discovery`);
    console.log(`  GET  /usage                      Usage report & activity`);
    console.log(`  GET  /stats                      Marketplace statistics`);
    console.log(`  GET  /attestations?type=&...     Query attestations`);
    console.log(`  POST /attestations               Submit attestation (auth + stake required)`);
    console.log(`  POST /attestations/:id/purchase  Buy attestation (auth required)`);
    console.log(`  POST /attestations/:id/dispute   Dispute attestation (auth required)`);
    console.log(`  GET  /bounties                   List open bounties`);
    console.log(`  POST /bounties                   Post funded bounty (auth required)`);
    console.log(`  POST /bounties/:id/claim         Claim a bounty (auth required)`);
    console.log(`  POST /bounties/:id/fulfill       Fulfill a bounty (auth required)`);
    console.log(`  GET  /verifiers                  List verifiers`);
    console.log(`  POST /verifiers                  Register verifier (auth required)`);
    console.log(`  GET  /wallets/:ownerId           Check balance`);
    console.log(`  POST /wallets/:ownerId/deposit   Deposit funds (auth required)`);
    console.log(`  GET  /welcome/:agentId           Agent onboarding + free credits`);
  });
}
