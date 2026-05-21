import { randomBytes, createHash } from 'crypto';
import { getDatabase } from '../registry/database.js';

export interface ApiAgent {
  agentId: string;
  name: string;
  createdAt: string;
}

function initAuthTables(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      agent_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(api_key_hash);
  `);
}

export function generateApiKey(name: string): { agentId: string; apiKey: string } {
  initAuthTables();
  const agentId = `ag_${randomBytes(4).toString('hex')}`;
  const apiKey = `fk_${randomBytes(32).toString('hex')}`;
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');

  const db = getDatabase();
  db.prepare('INSERT INTO api_keys (agent_id, name, api_key_hash) VALUES (?, ?, ?)').run(
    agentId,
    name,
    apiKeyHash
  );

  return { agentId, apiKey };
}

export function validateApiKey(agentId: string, apiKey: string): ApiAgent | null {
  initAuthTables();
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
  const db = getDatabase();
  const row = db.prepare(
    'SELECT agent_id, name, created_at FROM api_keys WHERE agent_id = ? AND api_key_hash = ?'
  ).get(agentId, apiKeyHash) as { agent_id: string; name: string; created_at: string } | undefined;

  if (!row) return null;
  return { agentId: row.agent_id, name: row.name, createdAt: row.created_at };
}

export function getAgentById(agentId: string): ApiAgent | null {
  initAuthTables();
  const db = getDatabase();
  const row = db.prepare(
    'SELECT agent_id, name, created_at FROM api_keys WHERE agent_id = ?'
  ).get(agentId) as { agent_id: string; name: string; created_at: string } | undefined;

  if (!row) return null;
  return { agentId: row.agent_id, name: row.name, createdAt: row.created_at };
}
