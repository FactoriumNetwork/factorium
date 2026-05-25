import { getOrCreateWallet, fundWalletDirectly } from '../payments/wallets.js';

const FREE_CREDITS = 1000;
const creditedAgents = new Set<string>();

export async function onboardAgent(agentId: string): Promise<boolean> {
  const wallet = await getOrCreateWallet(agentId, 'buyer');

  if (creditedAgents.has(agentId)) {
    return false;
  }

  await fundWalletDirectly(agentId, 'buyer', FREE_CREDITS);
  creditedAgents.add(agentId);
  return true;
}
