import { createPrivateKey, createPublicKey } from 'crypto';
import { getDatabase } from '../registry/database.js';
import { submitAttestation, hashSubject } from '../registry/attestations.js';
import { listVerifiers } from '../registry/verifiers.js';
import { canonicalAttestationPayload, signPayload } from '../trust/signing.js';
import { getTodaysFreshAttestations, incrementSeededFactsCount } from './seed-data.js';

let lastSeedDate: string | null = null;

// Accepts raw PEM or base64-encoded PEM (for env-var safety).
function decodeEnvPem(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('-----BEGIN')) return trimmed;
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) return decoded;
  } catch {}
  return trimmed;
}

function normalizePem(pem: string): string {
  return pem.replace(/\s+/g, '');
}

export async function autoSeedDailyIfNeeded(): Promise<{ seeded: number; skipped: boolean }> {
  const db = getDatabase();
  const today = new Date().toISOString().slice(0, 10);

  if (lastSeedDate === today) {
    return { seeded: 0, skipped: true };
  }

  const countResult = await db.query(
    "SELECT COUNT(*) as count FROM attestations WHERE subject LIKE $1",
    [`[${today}]%`]
  );
  if (parseInt(countResult.rows[0].count, 10) > 0) {
    lastSeedDate = today;
    return { seeded: 0, skipped: true };
  }

  const seedKeyEnv = process.env.SEED_VERIFIER_PRIVATE_KEY;
  if (!seedKeyEnv) {
    console.log('Auto-seed skipped: SEED_VERIFIER_PRIVATE_KEY is not set. Refusing to seed unsigned attestations.');
    lastSeedDate = today;
    return { seeded: 0, skipped: true };
  }

  const seedPrivateKeyPem = decodeEnvPem(seedKeyEnv);
  let seedPublicKeyPem: string;
  try {
    seedPublicKeyPem = createPublicKey(createPrivateKey(seedPrivateKeyPem)).export({ type: 'spki', format: 'pem' });
  } catch {
    console.log('Auto-seed skipped: SEED_VERIFIER_PRIVATE_KEY is not a valid private key PEM.');
    lastSeedDate = today;
    return { seeded: 0, skipped: true };
  }

  const verifiers = await listVerifiers(true);
  if (verifiers.length === 0) {
    return { seeded: 0, skipped: true };
  }

  const seedVerifier = verifiers.find(v => normalizePem(v.publicKey) === normalizePem(seedPublicKeyPem));
  if (!seedVerifier) {
    console.log('Auto-seed skipped: no active verifier public key matches SEED_VERIFIER_PRIVATE_KEY.');
    lastSeedDate = today;
    return { seeded: 0, skipped: true };
  }

  const facts = getTodaysFreshAttestations();
  let seeded = 0;

  for (const fact of facts) {
    try {
      const payload = canonicalAttestationPayload({
        type: fact.type, subjectHash: hashSubject(fact.subject), result: fact.result,
        confidence: fact.confidence, price: fact.price, verifierId: seedVerifier.id,
      });
      const signature = signPayload(seedPrivateKeyPem, payload);
      await submitAttestation({
        type: fact.type, subject: fact.subject, result: fact.result,
        resultSummary: fact.resultSummary, confidence: fact.confidence,
        price: fact.price, verifierId: seedVerifier.id, signature,
        royaltyPerAccess: 0, expiresInSeconds: 86400 * 7,
        metadata: { autoSeeded: true, date: today },
      });
      seeded++;
      incrementSeededFactsCount();
    } catch {
      // Skip duplicates
    }
  }

  lastSeedDate = today;
  return { seeded, skipped: false };
}
