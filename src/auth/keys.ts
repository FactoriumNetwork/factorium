import { randomBytes, createHash } from 'crypto';
import { getDatabase } from '../registry/database.js';

export interface ApiAgent {
  agentId: string;
  name: string;
  createdAt: string;
}

export async function generateApiKey(name: string): Promise<{ agentId: string; apiKey: string }> {
  const agentId = `ag_${randomBytes(4).toString('hex')}`;
  const apiKey = `fk_${randomBytes(32).toString('hex')}`;
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');

  const db = getDatabase();
  await db.query(
    'INSERT INTO api_keys (agent_id, name, api_key_hash) VALUES ($1, $2, $3) ON CONFLICT (agent_id) DO NOTHING',
    [agentId, name, apiKeyHash]
  );

  return { agentId, apiKey };
}

export function validateApiKey(agentId: string, apiKey: string): ApiAgent | null {
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
  const db = getDatabase();
  // This is called synchronously in middleware, so we use the pool directly
  // We'll handle this differently in the middleware
  return null;  // Placeholder - we need async validation
}

export async function validateApiKeyAsync(agentId: string, apiKey: string): Promise<ApiAgent | null> {
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
  const db = getDatabase();
  const result = await db.query(
    'SELECT agent_id, name, created_at FROM api_keys WHERE agent_id = $1 AND api_key_hash = $2',
    [agentId, apiKeyHash]
  );
  if (!result.rows[0]) return null;
  const r = result.rows[0];
  return { agentId: r.agent_id, name: r.name, createdAt: r.created_at };
}

export async function getAgentById(agentId: string): Promise<ApiAgent | null> {
  const db = getDatabase();
  const result = await db.query(
    'SELECT agent_id, name, created_at FROM api_keys WHERE agent_id = $1',
    [agentId]
  );
  if (!result.rows[0]) return null;
  const r = result.rows[0];
  return { agentId: r.agent_id, name: r.name, createdAt: r.created_at };
}
