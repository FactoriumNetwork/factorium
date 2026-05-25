import { v4 as uuid } from 'uuid';
import { getDatabase } from '../registry/database.js';
import { submitAttestation } from '../registry/attestations.js';
import { getVerifier } from '../registry/verifiers.js';
import { getOrCreateWallet } from '../payments/wallets.js';
import type { AttestationType } from '../types/index.js';

export interface Bounty {
  id: string;
  type: AttestationType;
  subject: string;
  subjectHash: string;
  reward: number;
  postedBy: string;
  fulfilledBy: string | null;
  attestationId: string | null;
  status: 'open' | 'claimed' | 'fulfilled' | 'expired' | 'cancelled';
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
}

interface BountyRow {
  id: string; type: string; subject: string; subject_hash: string;
  reward: number; posted_by: string; fulfilled_by: string | null;
  attestation_id: string | null; status: string; created_at: string;
  expires_at: string; claimed_at: string | null;
}

function rowToBounty(row: BountyRow): Bounty {
  return {
    id: row.id, type: row.type as AttestationType, subject: row.subject,
    subjectHash: row.subject_hash, reward: row.reward, postedBy: row.posted_by,
    fulfilledBy: row.fulfilled_by, attestationId: row.attestation_id,
    status: row.status as Bounty['status'], createdAt: row.created_at,
    expiresAt: row.expires_at, claimedAt: row.claimed_at,
  };
}

export async function postBounty(params: {
  type: AttestationType; subject: string; subjectHash: string;
  reward: number; postedBy: string; expiresInSeconds?: number;
}): Promise<Bounty> {
  const db = getDatabase();
  const wallet = await getOrCreateWallet(params.postedBy, 'buyer');
  if (wallet.balance < params.reward) {
    throw new Error(`Insufficient balance to fund bounty. Have ${wallet.balance}, need ${params.reward}.`);
  }

  const id = uuid();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (params.expiresInSeconds || 86400 * 7) * 1000).toISOString();

  await db.query('BEGIN');
  try {
    await db.query('UPDATE payment_wallets SET balance = balance - $1 WHERE owner_id = $2', [params.reward, params.postedBy]);
    await db.query('UPDATE payment_wallets SET balance = balance + $1 WHERE owner_id = $2', [params.reward, 'marketplace']);

    await db.query(
      'INSERT INTO bounties (id, type, subject, subject_hash, reward, posted_by, status, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, params.type, params.subject, params.subjectHash, params.reward, params.postedBy, 'open', now, expiresAt]
    );
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }

  return (await getBounty(id))!;
}

export async function getBounty(id: string): Promise<Bounty | null> {
  const db = getDatabase();
  const result = await db.query('SELECT * FROM bounties WHERE id = $1', [id]);
  return result.rows[0] ? rowToBounty(result.rows[0] as BountyRow) : null;
}

export async function listOpenBounties(type?: AttestationType, limit = 50): Promise<Bounty[]> {
  const db = getDatabase();
  let query = "SELECT * FROM bounties WHERE status = 'open' AND expires_at > NOW() AT TIME ZONE 'utc'";
  const params: unknown[] = [];
  let paramIdx = 1;

  if (type) { query += ` AND type = $${paramIdx++}`; params.push(type); }
  query += ` ORDER BY reward DESC LIMIT $${paramIdx++}`;
  params.push(limit);

  const result = await db.query(query, params);
  return result.rows.map(r => rowToBounty(r as BountyRow));
}

export async function claimBounty(bountyId: string, verifierId: string): Promise<Bounty> {
  const db = getDatabase();
  const bounty = await getBounty(bountyId);
  if (!bounty) throw new Error(`Bounty not found: ${bountyId}`);
  if (bounty.status !== 'open') throw new Error(`Bounty is not open: ${bountyId}`);
  if (new Date(bounty.expiresAt) < new Date()) throw new Error(`Bounty expired: ${bountyId}`);

  const verifier = await getVerifier(verifierId);
  if (!verifier) throw new Error(`Verifier not found: ${verifierId}`);
  if (!verifier.active) throw new Error(`Verifier inactive: ${verifierId}`);
  if (verifier.stakedAmount < bounty.reward * 10) {
    throw new Error(`Insufficient stake. Need ${bounty.reward * 10} (10x reward). Have ${verifier.stakedAmount}.`);
  }

  await db.query(
    "UPDATE bounties SET status = 'claimed', fulfilled_by = $1, claimed_at = NOW() AT TIME ZONE 'utc' WHERE id = $2",
    [verifierId, bountyId]
  );
  return (await getBounty(bountyId))!;
}

export async function fulfillBounty(
  bountyId: string, result: string, resultSummary: string, confidence: number
): Promise<{ bounty: Bounty; attestation: Awaited<ReturnType<typeof submitAttestation>> }> {
  const db = getDatabase();
  const bounty = await getBounty(bountyId);
  if (!bounty) throw new Error(`Bounty not found: ${bountyId}`);
  if (bounty.status !== 'claimed') throw new Error(`Bounty must be claimed first: ${bountyId}`);
  if (!bounty.fulfilledBy) throw new Error(`Bounty has no assigned verifier`);

  const attestation = await submitAttestation({
    type: bounty.type, subject: bounty.subject, result, resultSummary, confidence,
    verifierId: bounty.fulfilledBy, price: Math.round(bounty.reward * 0.1),
    royaltyPerAccess: Math.round(bounty.reward * 0.01), expiresInSeconds: null,
    metadata: { bountyId: bounty.id, source: 'bounty_fulfillment' },
  });

  await db.query(
    "UPDATE bounties SET status = 'fulfilled', attestation_id = $1, fulfilled_by = $2 WHERE id = $3",
    [attestation.id, bounty.fulfilledBy, bountyId]
  );

  await db.query('UPDATE payment_wallets SET balance = balance - $1 WHERE owner_id = $2', [bounty.reward, 'marketplace']);
  await db.query('UPDATE payment_wallets SET balance = balance + $1 WHERE owner_id = $2', [bounty.reward, bounty.fulfilledBy!]);

  return { bounty: (await getBounty(bountyId))!, attestation };
}

export async function cancelBounty(bountyId: string, requestedBy: string): Promise<Bounty> {
  const db = getDatabase();
  const bounty = await getBounty(bountyId);
  if (!bounty) throw new Error(`Bounty not found: ${bountyId}`);
  if (bounty.status !== 'open') throw new Error(`Only open bounties can be cancelled`);
  if (bounty.postedBy !== requestedBy) throw new Error(`Only the poster can cancel`);

  await db.query("UPDATE bounties SET status = 'cancelled' WHERE id = $1", [bountyId]);
  await db.query('UPDATE payment_wallets SET balance = balance - $1 WHERE owner_id = $2', [bounty.reward, 'marketplace']);
  await db.query('UPDATE payment_wallets SET balance = balance + $1 WHERE owner_id = $2', [bounty.reward, bounty.postedBy]);
  return (await getBounty(bountyId))!;
}

export async function getBountiesByPoster(posterId: string): Promise<Bounty[]> {
  const db = getDatabase();
  const result = await db.query('SELECT * FROM bounties WHERE posted_by = $1 ORDER BY created_at DESC', [posterId]);
  return result.rows.map(r => rowToBounty(r as BountyRow));
}
