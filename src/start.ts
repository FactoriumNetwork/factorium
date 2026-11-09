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
    // Only seed once — after that, real verifiers register through the API.
    console.log(`Database already has ${seeded.rows[0].count} verifiers, skipping seed`);
    return;
  }

  // One clearly-labeled demo verifier. The keypair is generated here and the
  // private key is used only to sign the initial demo attestations, then
  // discarded. Real verifiers register through POST /verifiers.
  const demoVerifier = await registerVerifier({
    name: 'Factorium Demo',
    endpoint: 'https://factorium.network/demo',
    initialStake: 10000,
  });

  const attestations = [
    {
      type: 'deepfake-detection' as const,
      subject: 'Demo: Viral political rally video — authenticity check',
      result: JSON.stringify({ isDeepfake: false, manipulationDetected: false, sourceVerified: true }),
      resultSummary: 'DEMO — Authentic: no manipulation detected. Multi-frame analysis confirms natural motion.',
      confidence: 0.96,
      price: 50,
      royaltyPerAccess: 5,
    },
    {
      type: 'fact-check' as const,
      subject: 'Demo: Claim: 80% of AI content undetectable by moderation tools',
      result: JSON.stringify({ verdict: 'mostly-false', actual: '42%', source: 'Stanford HAI 2025' }),
      resultSummary: 'DEMO — Mostly false: Stanford reports 42%, not 80%.',
      confidence: 0.91,
      price: 10,
      royaltyPerAccess: 1,
    },
    {
      type: 'code-audit' as const,
      subject: 'Demo: npm: node-ipc v9.2.1 — protestware audit',
      result: JSON.stringify({ audited: true, riskLevel: 'critical', cve: 'CVE-2022-23812' }),
      resultSummary: 'DEMO — Critical: CVE-2022-23812. Geolocation-triggered protestware overwrites user files.',
      confidence: 0.99,
      price: 25,
      royaltyPerAccess: 2,
    },
  ];

  for (const att of attestations) {
    const payload = canonicalAttestationPayload({
      type: att.type, subjectHash: hashSubject(att.subject), result: att.result,
      confidence: att.confidence, price: att.price, verifierId: demoVerifier.id,
    });
    const signature = signPayload(demoVerifier.privateKeyPem!, payload);
    await submitAttestation({
      ...att, verifierId: demoVerifier.id, signature,
      expiresInSeconds: null, metadata: { demo: true },
    });
  }

  console.log('Database seeded with 1 demo verifier and 3 demo attestations');
}

seedDatabase().then(() => {
  startAPI(Number(process.env.PORT) || 3099);
}).catch((err) => {
  console.error('Failed to initialize:', err);
  process.exit(1);
});
