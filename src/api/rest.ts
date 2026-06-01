import express from 'express';
import cors from 'cors';
import {
  submitAttestation, queryAttestations, purchaseAttestation,
  getAttestation, disputeAttestation, hashSubject, getAttestationsByVerifier,
} from '../registry/attestations.js';
import {
  registerVerifier, getVerifier, listVerifiers, stake, slash,
  updateReputation, getTopVerifiers, getStakingHistory,
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
import { logApiRequest, logActivity, getUsageReport } from '../monitoring/usage.js';
import { autoSeedDailyIfNeeded } from '../scheduler/auto-seed.js';
import { onboardAgent } from '../onboarding/agent-onboard.js';
import {
  postBounty, getBounty, listOpenBounties, claimBounty,
  fulfillBounty, cancelBounty, getBountiesByPoster,
} from '../bounties/bounty-market.js';
import { generateApiKey, validateApiKeyAsync } from '../auth/keys.js';
import { renderLanding, renderDashboard, renderLogin } from '../dashboard/html.js';
import { getOrCreateMCPServer, createMCPHttpTransport, createAndConnectMCPTransport } from '../mcp/server.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Factorium — Attestation Marketplace Protocol',
    description: 'Decentralized marketplace where AI systems buy and sell verified attestations.',
    version: '1.0.7',
    contact: { name: 'Factorium', url: 'https://factorium.network' },
  },
  servers: [{ url: 'https://factorium.network', description: 'Production' }],
  paths: {
    '/signup': { post: { summary: 'Create an agent account' } },
    '/attestations': {
      get: { summary: 'Query attestations' },
      post: { summary: 'Submit new attestation (auth required)' },
    },
    '/bounties': {
      get: { summary: 'List open bounties' },
      post: { summary: 'Post a funded bounty (auth required)' },
    },
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

  app.use((req, res, next) => {
    res.on('finish', () => {
      logApiRequest(req.method, req.path, req.ip || req.socket.remoteAddress || 'unknown',
        req.headers['user-agent'] as string | undefined, res.statusCode);
    });
    next();
  });

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
      let transport: StreamableHTTPServerTransport;
      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = createMCPHttpTransport();
        transport.onclose = () => { const sid = transport.sessionId; if (sid) transports.delete(sid); };
        await createAndConnectMCPTransport(transport);
      } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request' }, id: null });
        return;
      }
      await transport.handleRequest(req, res, req.body);
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

  app.get('/me', async (req, res) => {
    try {
      const agent = await resolveAuth(req);
      const wallet = await getWallet(agent.agentId);
      const bounties = await getBountiesByPoster(agent.agentId);
      const txns = await getBuyerHistory(agent.agentId);
      const verifier = await getVerifier(agent.agentId);
      res.json({ agent, wallet: wallet ? { balance: wallet.balance } : null, bountiesPosted: bounties.length, transactions: txns.length, isVerifier: !!verifier, verifier });
    } catch (err) { res.status(401).json({ error: String(err) }); }
  }, requireAuth);

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
      const attestation = await submitAttestation({ ...validated, verifierId: agent.agentId });
      await logActivity('attestation_submitted', `${attestation.type}: ${attestation.resultSummary.slice(0, 80)}`, agent.agentId);
      res.status(201).json(attestation);
    } catch (err) { res.status(400).json({ error: String(err) }); }
  });

  app.post('/attestations/:id/purchase', requireAuth, async (req, res) => {
    try {
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
      const bounty = await postBounty({ type, subject, subjectHash: hashSubject(subject), reward, postedBy: agent.agentId, expiresInSeconds });
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
      const { result, resultSummary, confidence } = req.body;
      if (!result || !resultSummary || confidence === undefined) { res.status(400).json({ error: 'result, resultSummary, confidence required' }); return; }
      const fulfilled = await fulfillBounty(req.params.id as string, result, resultSummary, confidence);
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

  app.post('/verifiers/:id/slash', requireAuth, async (req, res) => {
    try { res.json(await slash(req.params.id as string, req.body.amount, req.body.reason)); } catch (err) { res.status(400).json({ error: String(err) }); }
  });

  app.post('/verifiers/:id/reputation', requireAuth, async (req, res) => {
    try { res.json(await updateReputation(req.params.id as string, req.body.delta)); } catch (err) { res.status(400).json({ error: String(err) }); }
  });

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
