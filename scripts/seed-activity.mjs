import { readFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';

let signing;
try {
  signing = await import('../dist/src/trust/signing.js');
} catch {
  console.error('Failed to load dist/src/trust/signing.js. Run `npm run build` first.');
  process.exit(1);
}
const { canonicalAttestationPayload, signPayload } = signing;

const BASE = process.env.SEED_BASE_URL || 'https://factorium.network';

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Mirrors decodeEnvPem() in src/scheduler/auto-seed.ts: the env var may hold a
// raw PEM or a base64-encoded PEM (for env-var safety).
function decodeEnvPem(value) {
  const trimmed = value.trim();
  if (trimmed.includes('-----BEGIN')) return trimmed;
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) return decoded;
  } catch {}
  return trimmed;
}

function loadVerifierPrivateKey() {
  const inline = process.env.SEED_VERIFIER_PRIVATE_KEY;
  const file = process.env.SEED_VERIFIER_KEY_FILE;
  if (!inline && !file) {
    fail(
      'No verifier private key available. Set SEED_VERIFIER_PRIVATE_KEY (raw PEM or base64-encoded PEM) ' +
      'or SEED_VERIFIER_KEY_FILE (path to a PEM file), then re-run. Refusing to seed unsigned attestations.'
    );
  }
  if (inline) return decodeEnvPem(inline);
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    fail(`Could not read SEED_VERIFIER_KEY_FILE (${file}): ${err.message}`);
  }
}

const privateKeyPem = loadVerifierPrivateKey();
let publicKeyPem;
try {
  publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' });
} catch (err) {
  fail(`The verifier private key is not a valid PKCS#8 PEM: ${err.message}`);
}
console.log(
  'Verifier signing key loaded from',
  process.env.SEED_VERIFIER_PRIVATE_KEY ? 'SEED_VERIFIER_PRIVATE_KEY' : `SEED_VERIFIER_KEY_FILE (${process.env.SEED_VERIFIER_KEY_FILE})`
);

async function post(path, body, agentId, apiKey) {
  const headers = agentId
    ? { 'Content-Type': 'application/json', 'X-Agent-Id': agentId, 'X-Api-Key': apiKey }
    : { 'Content-Type': 'application/json' };
  const res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return res.json();
}

// Same canonical payload + signature flow the dashboard and auto-seed use:
// SHA-256 of the subject, sorted-key JSON over exactly the signed fields, then
// ed25519 over that payload with the verifier's private key.
function signAttestation(att, verifierId) {
  const subjectHash = createHash('sha256').update(att.subject).digest('hex');
  const payload = canonicalAttestationPayload({
    type: att.type,
    subjectHash,
    result: att.result,
    confidence: att.confidence,
    price: att.price,
    verifierId,
  });
  return signPayload(privateKeyPem, payload);
}

async function main() {
  // Create two agents
  const buyer = await post('/signup', { name: 'CryptoVerifierBot' });
  const seller = await post('/signup', { name: 'FactGuard AI' });
  console.log('Buyer:', buyer.agentId, '| Seller:', seller.agentId);

  // Register seller as a verifier. The server validates publicKey as an ed25519
  // PEM, so we hand it the public half of the key we sign with (omitting it would
  // make the server generate a different keypair that cannot verify our signatures).
  const registration = await post('/verifiers', {
    name: 'FactGuard AI',
    endpoint: 'https://factguard.ai/api/verify',
    publicKey: publicKeyPem,
    initialStake: 5000
  }, seller.agentId, seller.apiKey);
  if (registration.error) {
    console.log('Verifier registration failed (may already be registered):', registration.error);
  } else {
    console.log('Verifier registered');
  }

  const attestations = [
    { type: 'fact-check', subject: 'Bitcoin block reward after 2024 halving', result: '{"verdict":"true","details":"3.125 BTC post April 2024 halving at block 840,000"}', resultSummary: 'True: Post-2024 halving, BTC block reward is exactly 3.125 BTC.', confidence: 0.99, price: 5, royaltyPerAccess: 1 },
    { type: 'deepfake-detection', subject: 'Viral TikTok government confession voice analysis', result: '{"isDeepfake":true,"method":"AI voice synthesis","confidence":0.88,"markers":["unnatural pauses","formant mismatch"]}', resultSummary: 'Deepfake: AI voice synthesis detected. Formant mismatch confirms manipulation.', confidence: 0.88, price: 40, royaltyPerAccess: 4 },
    { type: 'content-authenticity', subject: 'Article: "Scientists discover perpetual motion machine" — viraltechdaily.com', result: '{"authentic":false,"reason":"Fabricated. No academic source. AI-generated image."}', resultSummary: 'Fabricated: No source exists. Clickbait headline with AI-generated image.', confidence: 0.96, price: 8, royaltyPerAccess: 1 },
    { type: 'identity-verification', subject: 'Domain: binance.com SSL and ownership verification', result: '{"verified":true,"sslValid":true,"org":"Binance Holdings","riskScore":0.01}', resultSummary: 'Verified: SSL valid. Organization confirmed. Low risk.', confidence: 0.99, price: 3, royaltyPerAccess: 0 },
    { type: 'code-audit', subject: 'npm: colors v1.4.0 intentional DoS vulnerability', result: '{"audited":true,"riskLevel":"high","cve":"CVE-2022-21803","desc":"Maintainer protest broke package"}', resultSummary: 'High risk: CVE-2022-21803. Maintainer deliberately broke package with infinite loop.', confidence: 0.99, price: 20, royaltyPerAccess: 2 }
  ];

  for (const att of attestations) {
    const signature = signAttestation(att, seller.agentId);
    const res = await post('/attestations', {
      ...att,
      verifierId: seller.agentId,
      signature,
    }, seller.agentId, seller.apiKey);
    if (res.error) {
      console.log('FAILED:', att.type, '-', res.error);
    } else {
      console.log('Submitted:', att.type);
    }
  }

  // Buyer purchases all seller's attestations
  const atts = await fetch(BASE + '/attestations?verifierId=' + seller.agentId).then(r => r.json());
  for (const att of atts.attestations) {
    await post('/attestations/' + att.id + '/purchase', {
      buyerId: buyer.agentId
    }, buyer.agentId, buyer.apiKey);
    console.log('Purchased:', att.type, '-', att.price, 'sats');
  }

  // Post bounties
  await post('/bounties', { type: 'fact-check', subject: 'Is the Fermi Paradox a formal scientific theory?', reward: 250, postedBy: buyer.agentId }, buyer.agentId, buyer.apiKey);
  await post('/bounties', { type: 'document-validation', subject: 'Validate authenticity of Declaration of Independence scan at archives.gov', reward: 500, postedBy: buyer.agentId }, buyer.agentId, buyer.apiKey);
  console.log('Bounties posted');

  const stats = await fetch(BASE + '/stats').then(r => r.json());
  console.log('\n=== MARKETPLACE LIVE ===');
  console.log('Attestations:', stats.totalAttestations);
  console.log('Verifiers:', stats.totalVerifiers);
  console.log('Transactions:', stats.totalTransactions);
  console.log('Volume:', stats.totalVolume, 'sats');
}

main().catch(e => console.error(e.message));
