import type { LightningInvoice } from './types.js';
import { LNBitsClient } from './lnbits.js';
import { OpenNodeClient } from './opennode.js';
import { AlbyClient } from './alby.js';

export type PaymentProvider = 'lnbits' | 'opennode' | 'alby';

interface LightningClient {
  createInvoice(amount: number, memo: string, expirySeconds?: number): Promise<LightningInvoice>;
  checkInvoice(paymentHash: string): Promise<boolean>;
  payInvoice(paymentRequest: string, amount: number, description: string): Promise<{ paymentHash: string }>;
  decodeInvoice(paymentRequest: string): Promise<{ amount: number; description: string }>;
  getBalance(): Promise<number>;
}

let client: LightningClient | null = null;
let provider: PaymentProvider | null = null;

export function getLightningClient(): LightningClient {
  if (!client) {
    provider = detectProvider();

    if (provider === 'alby') {
      const accessToken = process.env.ALBY_ACCESS_TOKEN || '';
      if (!accessToken) throw new Error('ALBY_ACCESS_TOKEN not set');
      client = new AlbyAdapter(new AlbyClient(accessToken));
    } else if (provider === 'opennode') {
      const apiKey = process.env.OPENNODE_API_KEY || '';
      if (!apiKey) throw new Error('OPENNODE_API_KEY not set');
      client = new OpenNodeAdapter(new OpenNodeClient(apiKey));
    } else {
      const baseUrl = process.env.LNBITS_URL || 'https://legend.lnbits.com';
      const adminKey = process.env.LNBITS_ADMIN_KEY || process.env.LNBITS_API_KEY || '';
      if (!adminKey) throw new Error('LNBITS_ADMIN_KEY or LNBITS_API_KEY not set');
      client = new LNBitsAdapter(new LNBitsClient(baseUrl, adminKey));
    }
  }
  return client;
}

function detectProvider(): PaymentProvider {
  if (process.env.ALBY_ACCESS_TOKEN) return 'alby';
  if (process.env.OPENNODE_API_KEY) return 'opennode';
  return 'lnbits';
}

export function isLightningConfigured(): boolean {
  return !!(process.env.ALBY_ACCESS_TOKEN || process.env.OPENNODE_API_KEY || process.env.LNBITS_ADMIN_KEY || process.env.LNBITS_API_KEY);
}

export function getPaymentProvider(): PaymentProvider | null {
  return provider;
}

class AlbyAdapter implements LightningClient {
  constructor(private alby: AlbyClient) {}
  async createInvoice(amount: number, memo: string, expirySeconds?: number) { return this.alby.createInvoice(amount, memo, expirySeconds); }
  async checkInvoice(paymentHash: string) { return this.alby.checkInvoice(paymentHash); }
  async payInvoice(paymentRequest: string, amount: number, description: string) { return this.alby.payInvoice(paymentRequest, amount, description); }
  async decodeInvoice(paymentRequest: string) { return this.alby.decodeInvoice(paymentRequest); }
  async getBalance() { return this.alby.getBalance(); }
}

class OpenNodeAdapter implements LightningClient {
  constructor(private on: OpenNodeClient) {}
  async createInvoice(amount: number, memo: string, expirySeconds?: number) { return this.on.createInvoice(amount, memo, expirySeconds); }
  async checkInvoice(paymentHash: string) { return this.on.checkInvoice(paymentHash); }
  async payInvoice(paymentRequest: string, amount: number, description: string) { return this.on.payInvoice(paymentRequest, amount, description); }
  async decodeInvoice(paymentRequest: string) {
    const r = await this.on.decodeInvoice(paymentRequest);
    return { amount: r.amount, description: r.memo };
  }
  async getBalance() { return this.on.getBalance(); }
}

class LNBitsAdapter implements LightningClient {
  constructor(private lnbits: LNBitsClient) {}
  async createInvoice(amount: number, memo: string, expirySeconds?: number) { return this.lnbits.createInvoice(amount, memo, expirySeconds); }
  async checkInvoice(paymentHash: string) { return this.lnbits.checkInvoice(paymentHash); }
  async payInvoice(paymentRequest: string, _amount: number, _description: string) { return this.lnbits.payInvoice(paymentRequest); }
  async decodeInvoice(paymentRequest: string) {
    const r = await this.lnbits.decodeInvoice(paymentRequest);
    return { amount: r.amount, description: r.memo };
  }
  async getBalance() { return this.lnbits.getWalletBalance(); }
}
