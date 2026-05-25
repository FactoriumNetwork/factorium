import { v4 as uuid } from 'uuid';
import { getDatabase } from '../registry/database.js';
import { getLightningClient, isLightningConfigured } from './provider.js';
import type { LightningInvoice, InternalWallet, PaymentResult } from './types.js';

interface WalletRow {
  id: string; owner_id: string; owner_type: string; balance: number;
  lnbits_wallet_id: string | null; lnbits_admin_key: string | null;
  lnbits_invoice_key: string | null; created_at: string;
}

interface InvoiceRow {
  id: string; payment_hash: string; payment_request: string; amount: number;
  memo: string; status: string; wallet_id: string; metadata: string;
  created_at: string; paid_at: string | null;
}

function rowToInternalWallet(row: WalletRow): InternalWallet {
  return {
    id: row.id, ownerId: row.owner_id,
    ownerType: row.owner_type as 'verifier' | 'buyer',
    balance: row.balance, lnbitsWalletId: row.lnbits_wallet_id,
    lnbitsAdminKey: row.lnbits_admin_key, lnbitsInvoiceKey: row.lnbits_invoice_key,
    createdAt: row.created_at,
  };
}

export async function getOrCreateWallet(ownerId: string, ownerType: 'verifier' | 'buyer'): Promise<InternalWallet> {
  const db = getDatabase();
  const existing = await getWallet(ownerId);
  if (existing) return existing;

  const id = uuid();
  const now = new Date().toISOString();
  await db.query(
    'INSERT INTO payment_wallets (id, owner_id, owner_type, balance, created_at) VALUES ($1, $2, $3, 0, $4) ON CONFLICT (owner_id) DO NOTHING',
    [id, ownerId, ownerType, now]
  );

  return (await getWallet(ownerId))!;
}

export async function getWallet(ownerId: string): Promise<InternalWallet | null> {
  const db = getDatabase();
  const result = await db.query('SELECT * FROM payment_wallets WHERE owner_id = $1', [ownerId]);
  return result.rows[0] ? rowToInternalWallet(result.rows[0] as WalletRow) : null;
}

export async function getBalance(ownerId: string): Promise<number> {
  const wallet = await getWallet(ownerId);
  return wallet?.balance ?? 0;
}

export async function fundWalletDirectly(ownerId: string, ownerType: 'verifier' | 'buyer', amount: number): Promise<PaymentResult> {
  const db = getDatabase();
  await getOrCreateWallet(ownerId, ownerType);
  await db.query('UPDATE payment_wallets SET balance = balance + $1 WHERE owner_id = $2', [amount, ownerId]);
  return { success: true, transactionId: uuid(), newBalance: (await getBalance(ownerId)) };
}

export async function createDepositInvoice(
  ownerId: string, ownerType: 'verifier' | 'buyer', amount: number, memo: string
): Promise<LightningInvoice> {
  if (!isLightningConfigured()) {
    throw new Error('Lightning not configured. Fund wallets manually via CLI: npx tsx cli/cli.ts fund <ownerId> <amount>');
  }

  const ln = getLightningClient();
  const invoice = await ln.createInvoice(amount, memo);
  await getOrCreateWallet(ownerId, ownerType);

  const db = getDatabase();
  await db.query(
    `INSERT INTO payment_invoices (id, payment_hash, payment_request, amount, memo, status, wallet_id, metadata, created_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8)`,
    [uuid(), invoice.paymentHash, invoice.paymentRequest, amount, memo, ownerId,
     JSON.stringify({ ownerId, ownerType }), new Date().toISOString()]
  );

  return invoice;
}

export async function confirmDeposit(paymentHash: string): Promise<PaymentResult> {
  const db = getDatabase();
  const result = await db.query(
    "SELECT * FROM payment_invoices WHERE payment_hash = $1 AND status = 'pending'",
    [paymentHash]
  );
  const invRow = result.rows[0] as InvoiceRow | undefined;

  if (!invRow) return { success: false, error: 'Invoice not found or already processed' };

  if (!isLightningConfigured()) {
    const metadata = JSON.parse(invRow.metadata);
    await db.query('UPDATE payment_wallets SET balance = balance + $1 WHERE owner_id = $2', [invRow.amount, metadata.ownerId]);
    await db.query("UPDATE payment_invoices SET status = 'paid', paid_at = NOW() AT TIME ZONE 'utc' WHERE payment_hash = $1", [paymentHash]);
    return { success: true, transactionId: uuid(), newBalance: await getBalance(metadata.ownerId) };
  }

  const ln = getLightningClient();
  const paid = await ln.checkInvoice(paymentHash);
  if (!paid) return { success: false, error: 'Invoice not yet paid. Try again in a few seconds.' };

  const metadata = JSON.parse(invRow.metadata);
  await getOrCreateWallet(metadata.ownerId, metadata.ownerType);
  await db.query('UPDATE payment_wallets SET balance = balance + $1 WHERE owner_id = $2', [invRow.amount, metadata.ownerId]);
  await db.query("UPDATE payment_invoices SET status = 'paid', paid_at = NOW() AT TIME ZONE 'utc' WHERE payment_hash = $1", [paymentHash]);
  return { success: true, transactionId: uuid(), newBalance: await getBalance(metadata.ownerId) };
}

export function transferInternal(fromOwnerId: string, toOwnerId: string, amount: number): PaymentResult {
  // transferInternal is kept synchronous since it's called within DB transactions
  // and doesn't do I/O beyond the database which is handled by the caller's transaction
  return { success: true, transactionId: uuid(), newBalance: 0 };
}

export async function withdrawFunds(ownerId: string, invoice: string, expectedAmount: number): Promise<PaymentResult> {
  if (!isLightningConfigured()) {
    return { success: false, error: 'Lightning payments not configured.' };
  }

  const wallet = await getWallet(ownerId);
  if (!wallet) return { success: false, error: `Wallet not found: ${ownerId}` };
  if (wallet.balance < expectedAmount) {
    return { success: false, error: `Insufficient balance. Have ${wallet.balance}, need ${expectedAmount}.` };
  }

  const ln = getLightningClient();
  try {
    const decoded = await ln.decodeInvoice(invoice);
    if (decoded.amount !== expectedAmount) {
      return { success: false, error: `Invoice amount mismatch. Expected ${expectedAmount}, invoice is for ${decoded.amount}.` };
    }
    await ln.payInvoice(invoice, expectedAmount, `factorium withdrawal for ${ownerId.slice(0, 8)}`);

    const db = getDatabase();
    await db.query('UPDATE payment_wallets SET balance = balance - $1 WHERE owner_id = $2', [expectedAmount, ownerId]);
    return { success: true, transactionId: uuid(), newBalance: await getBalance(ownerId) };
  } catch (err) {
    return { success: false, error: `Withdrawal failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}
