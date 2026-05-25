import { v4 as uuid } from 'uuid';
import { getDatabase } from './database.js';
import type { Verifier, StakingEvent } from '../types/index.js';

interface VerifierRow {
  id: string;
  name: string;
  endpoint: string;
  public_key: string;
  staked_amount: number;
  reputation_score: number;
  total_attestations: number;
  successful_attestations: number;
  disputed_attestations: number;
  registered_at: string;
  active: number;
}

function rowToVerifier(row: VerifierRow): Verifier {
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    publicKey: row.public_key,
    stakedAmount: row.staked_amount,
    reputationScore: row.reputation_score,
    totalAttestations: row.total_attestations,
    successfulAttestations: row.successful_attestations,
    disputedAttestations: row.disputed_attestations,
    registeredAt: row.registered_at,
    active: row.active === 1,
  };
}

export async function registerVerifier(params: {
  name: string;
  endpoint: string;
  publicKey: string;
  initialStake: number;
  id?: string;
}): Promise<Verifier> {
  const db = getDatabase();
  const id = params.id || uuid();
  const now = new Date().toISOString();

  await db.query(
    'INSERT INTO verifiers (id, name, endpoint, public_key, staked_amount, registered_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, params.name, params.endpoint, params.publicKey, params.initialStake, now]
  );

  await logStakingEvent(id, params.initialStake, 'stake', 'Initial verifier stake');

  return (await getVerifier(id))!;
}

export async function getVerifier(id: string): Promise<Verifier | null> {
  const db = getDatabase();
  const result = await db.query('SELECT * FROM verifiers WHERE id = $1', [id]);
  const row = result.rows[0] as VerifierRow | undefined;
  return row ? rowToVerifier(row) : null;
}

export async function listVerifiers(activeOnly = true): Promise<Verifier[]> {
  const db = getDatabase();
  const query = activeOnly
    ? 'SELECT * FROM verifiers WHERE active = 1 ORDER BY reputation_score DESC'
    : 'SELECT * FROM verifiers ORDER BY reputation_score DESC';
  const result = await db.query(query);
  return result.rows.map(r => rowToVerifier(r as VerifierRow));
}

export async function stake(verifierId: string, amount: number): Promise<Verifier> {
  const db = getDatabase();
  const verifier = await getVerifier(verifierId);
  if (!verifier) throw new Error(`Verifier not found: ${verifierId}`);
  if (!verifier.active) throw new Error(`Verifier is inactive: ${verifierId}`);

  await db.query('UPDATE verifiers SET staked_amount = staked_amount + $1 WHERE id = $2', [amount, verifierId]);
  await logStakingEvent(verifierId, amount, 'stake', 'Additional stake');
  return (await getVerifier(verifierId))!;
}

export async function unstake(verifierId: string, amount: number): Promise<Verifier> {
  const db = getDatabase();
  const verifier = await getVerifier(verifierId);
  if (!verifier) throw new Error(`Verifier not found: ${verifierId}`);
  if (verifier.stakedAmount - amount < 0) {
    throw new Error(`Insufficient stake. Current: ${verifier.stakedAmount}, requested: ${amount}`);
  }

  await db.query('UPDATE verifiers SET staked_amount = staked_amount - $1 WHERE id = $2', [amount, verifierId]);
  await logStakingEvent(verifierId, amount, 'unstake', 'Unstake requested');
  return (await getVerifier(verifierId))!;
}

export async function slash(verifierId: string, amount: number, reason: string): Promise<Verifier> {
  const db = getDatabase();
  const verifier = await getVerifier(verifierId);
  if (!verifier) throw new Error(`Verifier not found: ${verifierId}`);

  const slashAmount = Math.min(amount, verifier.stakedAmount);
  await db.query('UPDATE verifiers SET staked_amount = staked_amount - $1 WHERE id = $2', [slashAmount, verifierId]);
  await db.query(
    'UPDATE verifiers SET reputation_score = GREATEST(0, reputation_score - 10.0), active = CASE WHEN staked_amount <= 0 THEN 0 ELSE active END WHERE id = $1',
    [verifierId]
  );
  await logStakingEvent(verifierId, slashAmount, 'slash', reason);
  return (await getVerifier(verifierId))!;
}

export async function updateReputation(verifierId: string, delta: number): Promise<Verifier> {
  const db = getDatabase();
  await db.query(
    'UPDATE verifiers SET reputation_score = GREATEST(0, LEAST(1000, reputation_score + $1)) WHERE id = $2',
    [delta, verifierId]
  );
  return (await getVerifier(verifierId))!;
}

export async function deactivateVerifier(verifierId: string): Promise<Verifier> {
  const db = getDatabase();
  await db.query('UPDATE verifiers SET active = 0 WHERE id = $1', [verifierId]);
  return (await getVerifier(verifierId))!;
}

export async function activateVerifier(verifierId: string): Promise<Verifier> {
  const db = getDatabase();
  await db.query('UPDATE verifiers SET active = 1 WHERE id = $1', [verifierId]);
  return (await getVerifier(verifierId))!;
}

async function logStakingEvent(verifierId: string, amount: number, action: 'stake' | 'unstake' | 'slash', reason: string): Promise<void> {
  const db = getDatabase();
  await db.query(
    'INSERT INTO staking_events (id, verifier_id, amount, action, reason) VALUES ($1, $2, $3, $4, $5)',
    [uuid(), verifierId, amount, action, reason]
  );
}

export async function getStakingHistory(verifierId: string): Promise<StakingEvent[]> {
  const db = getDatabase();
  const result = await db.query(
    'SELECT * FROM staking_events WHERE verifier_id = $1 ORDER BY timestamp DESC',
    [verifierId]
  );
  return result.rows.map(r => ({
    id: r.id,
    verifierId: r.verifier_id,
    amount: r.amount,
    action: r.action as 'stake' | 'unstake' | 'slash',
    reason: r.reason,
    timestamp: r.timestamp,
  }));
}

export async function getTopVerifiers(limit = 10): Promise<Verifier[]> {
  const db = getDatabase();
  const result = await db.query(
    'SELECT * FROM verifiers WHERE active = 1 ORDER BY reputation_score DESC LIMIT $1',
    [limit]
  );
  return result.rows.map(r => rowToVerifier(r as VerifierRow));
}
