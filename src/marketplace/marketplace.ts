import { getDatabase } from '../registry/database.js';
import type { MarketplaceStats, Transaction } from '../types/index.js';

interface TransRow {
  id: string; attestation_id: string; buyer_id: string; verifier_id: string;
  amount: number; marketplace_fee: number; verifier_payout: number; timestamp: string;
}

export async function getMarketplaceStats(): Promise<MarketplaceStats> {
  const db = getDatabase();
  const result = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM attestations) as total_attestations,
      (SELECT COUNT(*) FROM verifiers) as total_verifiers,
      (SELECT COUNT(*) FROM transactions) as total_transactions,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions) as total_volume,
      (SELECT COALESCE(SUM(marketplace_fee), 0) FROM transactions) as total_fees,
      (SELECT COUNT(*) FROM attestations WHERE disputed = 0 AND (expires_at IS NULL OR expires_at > NOW() AT TIME ZONE 'utc')) as active_attestations,
      (SELECT COALESCE(AVG(price), 0) FROM attestations WHERE disputed = 0 AND (expires_at IS NULL OR expires_at > NOW() AT TIME ZONE 'utc')) as average_price
  `);

  const s = result.rows[0];
  const topRows = await db.query(
    'SELECT id, name, reputation_score FROM verifiers WHERE active = 1 ORDER BY reputation_score DESC LIMIT 10'
  );

  return {
    totalAttestations: parseInt(s.total_attestations, 10),
    totalVerifiers: parseInt(s.total_verifiers, 10),
    totalTransactions: parseInt(s.total_transactions, 10),
    totalVolume: parseFloat(s.total_volume),
    totalFees: parseFloat(s.total_fees),
    activeAttestations: parseInt(s.active_attestations, 10),
    averagePrice: parseFloat(s.average_price),
    topVerifiers: topRows.rows.map(r => ({
      id: r.id, name: r.name, reputationScore: r.reputation_score,
    })),
  };
}

export async function getRecentTransactions(limit = 50): Promise<Transaction[]> {
  const db = getDatabase();
  const result = await db.query('SELECT * FROM transactions ORDER BY timestamp DESC LIMIT $1', [limit]);
  return result.rows.map(r => ({
    id: r.id, attestationId: r.attestation_id, buyerId: r.buyer_id,
    verifierId: r.verifier_id, amount: r.amount, marketplaceFee: r.marketplace_fee,
    verifierPayout: r.verifier_payout, timestamp: r.timestamp,
  }));
}

export async function getBuyerHistory(buyerId: string): Promise<Transaction[]> {
  const db = getDatabase();
  const result = await db.query(
    'SELECT * FROM transactions WHERE buyer_id = $1 ORDER BY timestamp DESC',
    [buyerId]
  );
  return result.rows.map(r => ({
    id: r.id, attestationId: r.attestation_id, buyerId: r.buyer_id,
    verifierId: r.verifier_id, amount: r.amount, marketplaceFee: r.marketplace_fee,
    verifierPayout: r.verifier_payout, timestamp: r.timestamp,
  }));
}

export function calculateDynamicPrice(
  basePrice: number, accessCount: number, verifierReputation: number, daysSinceCreation: number
): number {
  const demandMultiplier = Math.max(1, Math.log10(accessCount + 1) * 0.5 + 1);
  const reputationMultiplier = Math.max(0.5, verifierReputation / 100);
  const ageDiscount = Math.max(0.3, Math.exp(-daysSinceCreation / 90));
  return Math.round(basePrice * demandMultiplier * reputationMultiplier * ageDiscount * 100) / 100;
}
