import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getDatabase(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is required for PostgreSQL');
    }

    pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      ssl: { rejectUnauthorized: false },
      statement_timeout: 10000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected PostgreSQL pool error:', err);
    });
  }
  return pool;
}

export async function initDatabase(): Promise<void> {
  const db = getDatabase();

  await db.query(`
    CREATE TABLE IF NOT EXISTS verifiers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      public_key TEXT NOT NULL,
      staked_amount REAL NOT NULL DEFAULT 0,
      reputation_score REAL NOT NULL DEFAULT 100.0,
      total_attestations INTEGER NOT NULL DEFAULT 0,
      successful_attestations INTEGER NOT NULL DEFAULT 0,
      disputed_attestations INTEGER NOT NULL DEFAULT 0,
      registered_at TEXT NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS attestations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      subject TEXT NOT NULL,
      subject_hash TEXT NOT NULL,
      result TEXT NOT NULL,
      result_summary TEXT NOT NULL,
      confidence REAL NOT NULL,
      verifier_id TEXT NOT NULL,
      verifier_signature TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      royalty_per_access REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
      expires_at TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      disputed INTEGER NOT NULL DEFAULT 0,
      dispute_reason TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      UNIQUE(subject_hash, verifier_id),
      FOREIGN KEY (verifier_id) REFERENCES verifiers(id)
    );

    CREATE TABLE IF NOT EXISTS staking_events (
      id TEXT PRIMARY KEY,
      verifier_id TEXT NOT NULL,
      amount REAL NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('stake', 'unstake', 'slash')),
      reason TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
      FOREIGN KEY (verifier_id) REFERENCES verifiers(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      attestation_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      verifier_id TEXT NOT NULL,
      amount REAL NOT NULL,
      marketplace_fee REAL NOT NULL,
      verifier_payout REAL NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
      FOREIGN KEY (attestation_id) REFERENCES attestations(id),
      FOREIGN KEY (verifier_id) REFERENCES verifiers(id)
    );

    CREATE TABLE IF NOT EXISTS api_requests (
      id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      ip TEXT NOT NULL,
      user_agent TEXT,
      status_code INTEGER,
      timestamp TEXT NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      detail TEXT NOT NULL,
      actor_id TEXT,
      timestamp TEXT NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
    );

    CREATE TABLE IF NOT EXISTS bounties (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      subject TEXT NOT NULL,
      subject_hash TEXT NOT NULL,
      reward INTEGER NOT NULL,
      posted_by TEXT NOT NULL,
      fulfilled_by TEXT,
      attestation_id TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'claimed', 'fulfilled', 'expired', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
      expires_at TEXT NOT NULL,
      claimed_at TEXT,
      FOREIGN KEY (attestation_id) REFERENCES attestations(id)
    );

    CREATE TABLE IF NOT EXISTS payment_wallets (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL UNIQUE,
      owner_type TEXT NOT NULL CHECK(owner_type IN ('verifier', 'buyer', 'marketplace')),
      balance INTEGER NOT NULL DEFAULT 0,
      lnbits_wallet_id TEXT,
      lnbits_admin_key TEXT,
      lnbits_invoice_key TEXT,
      created_at TEXT NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
    );

    CREATE TABLE IF NOT EXISTS payment_invoices (
      id TEXT PRIMARY KEY,
      payment_hash TEXT NOT NULL UNIQUE,
      payment_request TEXT NOT NULL,
      amount INTEGER NOT NULL,
      memo TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'expired', 'cancelled')),
      wallet_id TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
      paid_at TEXT
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      agent_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
    );
  `);

  // Create indexes
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_attestations_type ON attestations(type);
    CREATE INDEX IF NOT EXISTS idx_attestations_subject_hash ON attestations(subject_hash);
    CREATE INDEX IF NOT EXISTS idx_attestations_verifier ON attestations(verifier_id);
    CREATE INDEX IF NOT EXISTS idx_attestations_confidence ON attestations(confidence);
    CREATE INDEX IF NOT EXISTS idx_attestations_price ON attestations(price);
    CREATE INDEX IF NOT EXISTS idx_attestations_created ON attestations(created_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_buyer ON transactions(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_api_requests_timestamp ON api_requests(timestamp);
    CREATE INDEX IF NOT EXISTS idx_api_requests_ip ON api_requests(ip);
    CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp ON activity_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_bounties_status ON bounties(status);
    CREATE INDEX IF NOT EXISTS idx_bounties_type ON bounties(type);
    CREATE INDEX IF NOT EXISTS idx_bounties_subject_hash ON bounties(subject_hash);
    CREATE INDEX IF NOT EXISTS idx_payment_invoices_hash ON payment_invoices(payment_hash);
    CREATE INDEX IF NOT EXISTS idx_payment_invoices_status ON payment_invoices(status);
    CREATE INDEX IF NOT EXISTS idx_payment_wallets_owner ON payment_wallets(owner_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(api_key_hash);
  `);

  // Insert marketplace wallet if not exists
  await db.query(`
    INSERT INTO payment_wallets (id, owner_id, owner_type, balance, created_at)
    VALUES ('marketplace', 'marketplace', 'marketplace', 0, NOW() AT TIME ZONE 'utc')
    ON CONFLICT (owner_id) DO NOTHING
  `);
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
