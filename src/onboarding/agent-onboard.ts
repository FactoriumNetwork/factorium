import { getDatabase } from '../registry/database.js';
import { getOrCreateWallet } from '../payments/wallets.js';

const FREE_CREDITS = 1000;

/**
 * Award the one-time signup credit.
 *
 * The award is persisted on the wallet row (free_credits_awarded) and the
 * balance update is a single atomic UPDATE ... WHERE free_credits_awarded =
 * FALSE, so an agent can never be credited twice — even across restarts or
 * concurrent requests. Returns true only when this call actually credited.
 */
export async function onboardAgent(agentId: string): Promise<boolean> {
  // Ensure the wallet exists before the conditional credit.
  await getOrCreateWallet(agentId, 'buyer');

  const db = getDatabase();
  const result = await db.query(
    `UPDATE payment_wallets
     SET free_credits_awarded = TRUE, balance = balance + $2
     WHERE owner_id = $1 AND free_credits_awarded = FALSE
     RETURNING balance`,
    [agentId, FREE_CREDITS]
  );

  return (result.rowCount ?? 0) > 0;
}
