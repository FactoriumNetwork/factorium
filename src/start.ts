import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDatabase } from './registry/database.js';
import { registerVerifier } from './registry/verifiers.js';
import { submitAttestation } from './registry/attestations.js';
import { startAPI } from './api/rest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
const dbPath = join(dataDir, 'marketplace.db');

if (!existsSync(dbPath)) {
  mkdirSync(dataDir, { recursive: true });
  const db = getDatabase();

  const v1 = registerVerifier({
    name: 'Hive Moderation',
    endpoint: 'https://hivemoderation.com/api/verify',
    publicKey: 'ed25519:hv_7a3b2c1d4e5f6a8b9c0d1e2f3a4b5c6',
    initialStake: 10000,
  });

  const v2 = registerVerifier({
    name: 'Sensity AI',
    endpoint: 'https://sensity.ai/api/verify',
    publicKey: 'ed25519:sn_2f3e4d5c6b7a8c9d0e1f2a3b4c5d6e7',
    initialStake: 25000,
  });

  const v3 = registerVerifier({
    name: 'GPTZero',
    endpoint: 'https://gptzero.me/api/verify',
    publicKey: 'ed25519:gz_9i8u7y6t5r4e3w2q1a0s9d8f7g6h5',
    initialStake: 50000,
  });

  submitAttestation({
    type: 'deepfake-detection',
    subject: 'https://www.youtube.com/watch?v=SY4QTksqL_M — "A Conversation with the President" viral clip',
    result: JSON.stringify({ isDeepfake: false, manipulationDetected: false, sourceVerified: true, analysisMethod: 'multi-frame GAN detection + audio waveform analysis' }),
    resultSummary: 'Authentic: Video and audio show no signs of manipulation. Multi-frame analysis confirms natural motion patterns.',
    confidence: 0.96,
    verifierId: v2.id,
    price: 50,
    royaltyPerAccess: 5,
    expiresInSeconds: null,
    metadata: { category: 'political-media', modelUsed: 'sensity-deepfake-v3' },
  });

  submitAttestation({
    type: 'deepfake-detection',
    subject: 'https://twitter.com/celebrity_account/viral_voice_clip.mp3 — Celebrity endorsement audio',
    result: JSON.stringify({ isDeepfake: true, manipulationDetected: true, method: 'voice-cloning', modelMatch: 'ElevenLabs voice synthesis fingerprint detected' }),
    resultSummary: 'Deepfake detected: Audio voiceprint matches ElevenLabs synthesis, not natural human speech.',
    confidence: 0.94,
    verifierId: v2.id,
    price: 75,
    royaltyPerAccess: 7,
    expiresInSeconds: null,
    metadata: { category: 'voice-cloning', modelDetected: 'elevenlabs-v2' },
  });

  submitAttestation({
    type: 'fact-check',
    subject: 'Claim: "80% of AI-generated content online is undetectable by current moderation tools"',
    result: JSON.stringify({ verdict: 'mostly-false', actualRate: '42%', source: 'Stanford HAI 2025 AI Index Report', methodology: 'sampled 10,000 web pages across 50 domains' }),
    resultSummary: 'Mostly false: Stanford HAI reports actual rate at 42%, not 80%. Overstated by nearly 2x.',
    confidence: 0.91,
    verifierId: v1.id,
    price: 10,
    royaltyPerAccess: 1,
    expiresInSeconds: 86400 * 90,
    metadata: { source: 'stanford-hai-2025', category: 'ai-statistics' },
  });

  submitAttestation({
    type: 'content-authenticity',
    subject: 'Article: "New study proves coffee causes cancer" — viralhealthnews.com',
    result: JSON.stringify({ authentic: false, reason: 'Article misrepresents study which found no causal link. Original study examined correlation only with r=0.12.', sourceVerified: false }),
    resultSummary: 'False: Article misrepresents study findings. Original study found no causal link between coffee and cancer.',
    confidence: 0.93,
    verifierId: v3.id,
    price: 8,
    royaltyPerAccess: 1,
    expiresInSeconds: null,
    metadata: { category: 'health-misinformation', originalStudy: 'doi:10.1056/NEJMoa2025-001' },
  });

  submitAttestation({
    type: 'identity-verification',
    subject: 'Domain: factorium.network — SSL certificate and domain ownership',
    result: JSON.stringify({ verified: true, sslValid: true, domainAge: '2025', registrar: 'verified', riskScore: 0.05 }),
    resultSummary: 'Verified: SSL certificate valid, domain registered 2025, low fraud risk.',
    confidence: 0.99,
    verifierId: v3.id,
    price: 3,
    royaltyPerAccess: 0,
    expiresInSeconds: null,
    metadata: { category: 'domain-verification' },
  });

  submitAttestation({
    type: 'code-audit',
    subject: 'npm package: node-ipc v9.2.1 — security audit for peacenotwar protestware',
    result: JSON.stringify({ audited: true, riskLevel: 'critical', cve: 'CVE-2022-23812', vulnerabilities: 1, description: 'Package contains protestware that overwrites files based on geolocation. Supply chain threat.' }),
    resultSummary: 'Critical risk: CVE-2022-23812. Package contains geolocation-triggered protestware that overwrites user files.',
    confidence: 0.99,
    verifierId: v3.id,
    price: 25,
    royaltyPerAccess: 2,
    expiresInSeconds: null,
    metadata: { category: 'supply-chain', cve: 'CVE-2022-23812' },
  });

  console.log('Database seeded with 3 verifiers and 5 attestations');
}

startAPI(Number(process.env.PORT) || 3099);
