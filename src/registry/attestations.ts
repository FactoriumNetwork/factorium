import { v4 as uuid } from 'uuid';
import { createHash } from 'crypto';
import { getDatabase } from './database.js';
import { updateReputation } from './verifiers.js';
import type { Attestation, AttestationQuery, QueryResult, AttestationType, Transaction } from '../types/index.js';

interface AttRow {
  id: string; type: string; subject: string; subject_hash: string; result: string;
  result_summary: string; confidence: number; verifier_id: string; verifier_signature: string;
  price: number; royalty_per_access: number; created_at: string; expires_at: string | null;
  access_count: number; disputed: number; dispute_reason: string | null; metadata: string;
}

function rowToAttestation(row: AttRow): Attestation {
  let metadata = {};
  try { metadata = JSON.parse(row.metadata || '{}'); } catch {}
  return {
    id: row.id, type: row.type as AttestationType, subject: row.subject,
    subjectHash: row.subject_hash, result: row.result, resultSummary: row.result_summary,
    confidence: row.confidence, verifierId: row.verifier_id, verifierSignature: row.verifier_signature,
    price: row.price, royaltyPerAccess: row.royalty_per_access, createdAt: row.created_at,
    expiresAt: row.expires_at, accessCount: row.access_count, disputed: row.disputed === 1,
    disputeReason: row.dispute_reason, metadata,
  };
}

export function hashSubject(subject: string): string {
  return createHash('sha256').update(subject).digest('hex');
}

export async function submitAttestation(params: {
  type: AttestationType; subject: string; result: string; resultSummary: string;
  confidence: number; verifierId: string; price: number; royaltyPerAccess: number;
  expiresInSeconds: number | null; metadata: Record<string, unknown>;
}): Promise<Attestation> {
  const db = getDatabase();
  const id = uuid();
  const now = new Date().toISOString();
  const subjectHash = hashSubject(params.subject);
  const signature = `sig:${params.verifierId}:${subjectHash.slice(0, 32)}`;
  const expiresAt = params.expiresInSeconds
    ? new Date(Date.now() + params.expiresInSeconds * 1000).toISOString()
    : null;

  await db.query(
    `INSERT INTO attestations (id, type, subject, subject_hash, result, result_summary, confidence,
      verifier_id, verifier_signature, price, royalty_per_access, created_at, expires_at, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, params.type, params.subject, subjectHash, params.result, params.resultSummary,
     params.confidence, params.verifierId, signature, params.price, params.royaltyPerAccess,
     now, expiresAt, JSON.stringify(params.metadata)]
  );

  await db.query(
    'UPDATE verifiers SET total_attestations = total_attestations + 1, successful_attestations = successful_attestations + 1 WHERE id = $1',
    [params.verifierId]
  );

  return (await getAttestation(id))!;
}

export async function getAttestation(id: string): Promise<Attestation | null> {
  const db = getDatabase();
  const result = await db.query('SELECT * FROM attestations WHERE id = $1', [id]);
  return result.rows[0] ? rowToAttestation(result.rows[0] as AttRow) : null;
}

export async function queryAttestations(query: AttestationQuery): Promise<QueryResult> {
  const db = getDatabase();
  const conditions: string[] = ['disputed = 0', "(expires_at IS NULL OR expires_at > NOW() AT TIME ZONE 'utc')"];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (query.type) { conditions.push(`type = $${paramIdx++}`); params.push(query.type); }
  if (query.subjectHash) { conditions.push(`subject_hash = $${paramIdx++}`); params.push(query.subjectHash); }
  if (query.subject) {
    conditions.push(`subject ILIKE $${paramIdx++}`);
    params.push(`%${query.subject}%`);
  }
  if (query.verifierId) { conditions.push(`verifier_id = $${paramIdx++}`); params.push(query.verifierId); }
  if (query.minConfidence !== undefined) { conditions.push(`confidence >= $${paramIdx++}`); params.push(query.minConfidence); }
  if (query.maxPrice !== undefined) { conditions.push(`price <= $${paramIdx++}`); params.push(query.maxPrice); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = query.sortBy === 'confidence' ? 'confidence DESC' :
    query.sortBy === 'price' ? 'price ASC' :
    query.sortBy === 'reputation' ? 'reputation_score DESC' : 'created_at DESC';
  const order = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const limit = query.limit || 50;
  const offset = query.offset || 0;

  const countResult = await db.query(`SELECT COUNT(*) as count FROM attestations ${where}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  const dataResult = await db.query(
    `SELECT a.* FROM attestations a LEFT JOIN verifiers v ON a.verifier_id = v.id ${where} ORDER BY ${orderBy} ${order} LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limit, offset]
  );

  const attestations = dataResult.rows.map(r => rowToAttestation(r as AttRow));
  const prices = attestations.map(a => a.price).filter(p => p > 0);

  return {
    attestations,
    total,
    queryCost: attestations.length * 0.1,
    cheapestPrice: prices.length ? Math.min(...prices) : null,
    averagePrice: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
  };
}

export async function purchaseAttestation(
  attestationId: string,
  buyerId: string
): Promise<{ transactionId: string; attestation: Attestation }> {
  const db = getDatabase();
  const attestation = await getAttestation(attestationId);
  if (!attestation) throw new Error(`Attestation not found: ${attestationId}`);
  const fee = Math.round(attestation.price * 0.1 * 100) / 100;
  const payout = attestation.price - fee;
  const txnId = uuid();

  await db.query('BEGIN');

  try {
    // Deduct from buyer
    const buyerWallet = await db.query('SELECT balance FROM payment_wallets WHERE owner_id = $1 FOR UPDATE', [buyerId]);
    if (!buyerWallet.rows[0] || buyerWallet.rows[0].balance < attestation.price) {
      throw new Error(`Insufficient balance. Need ${attestation.price} sats.`);
    }
    await db.query('UPDATE payment_wallets SET balance = balance - $1 WHERE owner_id = $2', [attestation.price, buyerId]);

    // Pay verifier (minus fee)
    await db.query('UPDATE payment_wallets SET balance = balance + $1 WHERE owner_id = $2', [payout, attestation.verifierId]);

    // Pay marketplace fee
    await db.query('UPDATE payment_wallets SET balance = balance + $1 WHERE owner_id = $2', [fee, 'marketplace']);

    await db.query(
      `INSERT INTO transactions (id, attestation_id, buyer_id, verifier_id, amount, marketplace_fee, verifier_payout)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [txnId, attestationId, buyerId, attestation.verifierId, attestation.price, fee, payout]
    );

    await db.query('UPDATE attestations SET access_count = access_count + 1 WHERE id = $1', [attestationId]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }

  return { transactionId: txnId, attestation: (await getAttestation(attestationId))! };
}

export async function disputeAttestation(attestationId: string, reason: string): Promise<Attestation> {
  const db = getDatabase();
  const attestation = await getAttestation(attestationId);
  if (!attestation) throw new Error(`Attestation not found: ${attestationId}`);

  await db.query(
    'UPDATE attestations SET disputed = 1, dispute_reason = $1 WHERE id = $2',
    [reason, attestationId]
  );

  await db.query(
    'UPDATE verifiers SET disputed_attestations = disputed_attestations + 1 WHERE id = $1',
    [attestation.verifierId]
  );

  await updateReputation(attestation.verifierId, -5);

  return (await getAttestation(attestationId))!;
}

export async function getAttestationsByVerifier(verifierId: string): Promise<Attestation[]> {
  const db = getDatabase();
  const result = await db.query(
    'SELECT * FROM attestations WHERE verifier_id = $1 ORDER BY created_at DESC',
    [verifierId]
  );
  return result.rows.map(r => rowToAttestation(r as AttRow));
}
