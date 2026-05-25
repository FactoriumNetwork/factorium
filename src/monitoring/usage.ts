import { v4 as uuid } from 'uuid';
import { getDatabase } from '../registry/database.js';

export async function logApiRequest(
  method: string, path: string, ip: string, userAgent: string | undefined, statusCode: number
): Promise<void> {
  const db = getDatabase();
  await db.query(
    'INSERT INTO api_requests (id, method, path, ip, user_agent, status_code) VALUES ($1,$2,$3,$4,$5,$6)',
    [uuid(), method, path, ip, userAgent || null, statusCode]
  );
}

export async function logActivity(event: string, detail: string, actorId?: string): Promise<void> {
  const db = getDatabase();
  await db.query(
    'INSERT INTO activity_log (id, event, detail, actor_id) VALUES ($1,$2,$3,$4)',
    [uuid(), event, detail, actorId || null]
  );
}

export async function getUsageReport(): Promise<Record<string, unknown>> {
  const db = getDatabase();

  const last24 = await db.query(`
    SELECT
      COUNT(*) as total_requests,
      COUNT(DISTINCT ip) as unique_ips,
      (SELECT COUNT(*) FROM transactions WHERE timestamp > NOW() AT TIME ZONE 'utc' - INTERVAL '24 hours') as transactions,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE timestamp > NOW() AT TIME ZONE 'utc' - INTERVAL '24 hours') as transaction_volume,
      (SELECT COUNT(*) FROM attestations WHERE created_at > NOW() AT TIME ZONE 'utc' - INTERVAL '24 hours') as new_attestations,
      (SELECT COUNT(*) FROM verifiers WHERE registered_at > NOW() AT TIME ZONE 'utc' - INTERVAL '24 hours') as new_verifiers
  `);

  const topEndpoints = await db.query(
    `SELECT path, COUNT(*) as count FROM api_requests
     WHERE timestamp > NOW() AT TIME ZONE 'utc' - INTERVAL '24 hours'
     GROUP BY path ORDER BY count DESC LIMIT 20`
  );

  const topIps = await db.query(
    `SELECT ip, COUNT(*) as count FROM api_requests
     WHERE timestamp > NOW() AT TIME ZONE 'utc' - INTERVAL '24 hours'
     GROUP BY ip ORDER BY count DESC LIMIT 10`
  );

  const allTime = await db.query(`
    SELECT
      COUNT(*) as total_requests,
      (SELECT COUNT(*) FROM transactions) as total_transactions,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions) as total_volume,
      (SELECT COUNT(*) FROM attestations) as total_attestations,
      (SELECT COUNT(*) FROM verifiers) as total_verifiers,
      (SELECT COUNT(DISTINCT buyer_id) FROM transactions) as unique_buyers
    FROM api_requests
  `);

  const recentActivity = await db.query(
    'SELECT * FROM activity_log ORDER BY timestamp DESC LIMIT 30'
  );

  const recentRequests = await db.query(
    'SELECT * FROM api_requests ORDER BY timestamp DESC LIMIT 30'
  );

  return {
    last24Hours: {
      totalRequests: parseInt(last24.rows[0].total_requests, 10),
      uniqueIps: parseInt(last24.rows[0].unique_ips, 10),
      transactions: parseInt(last24.rows[0].transactions, 10),
      transactionVolume: parseFloat(last24.rows[0].transaction_volume),
      newAttestations: parseInt(last24.rows[0].new_attestations, 10),
      newVerifiers: parseInt(last24.rows[0].new_verifiers, 10),
      topEndpoints: topEndpoints.rows.map(r => ({ path: r.path, count: parseInt(r.count, 10) })),
      topIps: topIps.rows.map(r => ({ ip: r.ip, count: parseInt(r.count, 10) })),
    },
    allTime: {
      totalRequests: parseInt(allTime.rows[0].total_requests, 10),
      totalTransactions: parseInt(allTime.rows[0].total_transactions, 10),
      totalVolume: parseFloat(allTime.rows[0].total_volume),
      totalAttestations: parseInt(allTime.rows[0].total_attestations, 10),
      totalVerifiers: parseInt(allTime.rows[0].total_verifiers, 10),
      uniqueBuyers: parseInt(allTime.rows[0].unique_buyers, 10),
    },
    recentActivity: recentActivity.rows,
    recentRequests: recentRequests.rows,
  };
}
