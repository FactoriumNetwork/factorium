import { getDatabase, initDatabase } from './registry/database.js';
import { registerVerifier } from './registry/verifiers.js';
import { submitAttestation, hashSubject } from './registry/attestations.js';
import { canonicalAttestationPayload, signPayload } from './trust/signing.js';
import { startAPI } from './api/rest.js';

async function seedDatabase(): Promise<void> {
  await initDatabase();

  const db = getDatabase();
  const seeded = await db.query("SELECT COUNT(*) as count FROM verifiers");

  if (parseInt(seeded.rows[0].count, 10) > 0) {
    // Only seed once — after that, auto-seeder handles daily fresh data
    console.log(`Database already has ${seeded.rows[0].count} verifiers, skipping seed`);
    return;
  }

  // Server-assisted seed verifiers: keypairs are generated here and the private
  // keys are used only to sign the initial seed attestations, then discarded.
  const v1 = await registerVerifier({
    name: 'Hive Moderation',
    endpoint: 'https://hivemoderation.com/api/verify',
    initialStake: 10000,
  });

  const v2 = await registerVerifier({
    name: 'Sensity AI',
    endpoint: 'https://sensity.ai/api/verify',
    initialStake: 25000,
  });

  const v3 = await registerVerifier({
    name: 'GPTZero',
    endpoint: 'https://gptzero.me/api/verify',
    initialStake: 50000,
  });

  const privateKeys = new Map<string, string>([
    [v1.id, v1.privateKeyPem!],
    [v2.id, v2.privateKeyPem!],
    [v3.id, v3.privateKeyPem!],
  ]);

  const attestations = [
    { type: 'deepfake-detection' as const, subject: 'Viral political rally video — authenticity check', result: JSON.stringify({ isDeepfake: false, manipulationDetected: false, sourceVerified: true }), resultSummary: 'Authentic: No manipulation detected. Multi-frame analysis confirms natural motion.', confidence: 0.96, verifierId: v2.id, price: 50, royaltyPerAccess: 5 },
    { type: 'deepfake-detection' as const, subject: 'Celebrity endorsement audio — voice cloning check', result: JSON.stringify({ isDeepfake: true, method: 'voice-cloning', fingerprint: 'ElevenLabs synthesis' }), resultSummary: 'Deepfake: Audio matches ElevenLabs voice synthesis, not natural speech.', confidence: 0.94, verifierId: v2.id, price: 75, royaltyPerAccess: 7 },
    { type: 'fact-check' as const, subject: 'Claim: 80% of AI content undetectable by moderation tools', result: JSON.stringify({ verdict: 'mostly-false', actual: '42%', source: 'Stanford HAI 2025' }), resultSummary: 'Mostly false: Stanford reports 42%, not 80%.', confidence: 0.91, verifierId: v1.id, price: 10, royaltyPerAccess: 1 },
    { type: 'content-authenticity' as const, subject: 'Article: "Coffee causes cancer" — viralhealthnews.com', result: JSON.stringify({ authentic: false, reason: 'Misrepresents study. No causal link found.' }), resultSummary: 'False: Article fabricates causal link not found in original study.', confidence: 0.93, verifierId: v3.id, price: 8, royaltyPerAccess: 1 },
    { type: 'identity-verification' as const, subject: 'Domain: factorium.network — SSL and ownership', result: JSON.stringify({ verified: true, sslValid: true, riskScore: 0.05 }), resultSummary: 'Verified: SSL valid, low fraud risk.', confidence: 0.99, verifierId: v3.id, price: 3, royaltyPerAccess: 0 },
    { type: 'code-audit' as const, subject: 'npm: node-ipc v9.2.1 — protestware audit', result: JSON.stringify({ audited: true, riskLevel: 'critical', cve: 'CVE-2022-23812' }), resultSummary: 'Critical: CVE-2022-23812. Geolocation-triggered protestware overwrites user files.', confidence: 0.99, verifierId: v3.id, price: 25, royaltyPerAccess: 2 },
  ];

  for (const att of attestations) {
    const payload = canonicalAttestationPayload({
      type: att.type, subjectHash: hashSubject(att.subject), result: att.result,
      confidence: att.confidence, price: att.price, verifierId: att.verifierId,
    });
    const signature = signPayload(privateKeys.get(att.verifierId)!, payload);
    await submitAttestation({ ...att, signature, expiresInSeconds: null, metadata: {} });
  }

  console.log('Database seeded with 3 verifiers and 6 attestations');
}

seedDatabase().then(() => {
  startAPI(Number(process.env.PORT) || 3099);
}).catch((err) => {
  console.error('Failed to initialize:', err);
  process.exit(1);
});
