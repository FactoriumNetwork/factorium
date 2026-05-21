import type { LightningInvoice, PaymentResult } from './types.js';

const ALBY_API = 'https://api.getalby.com';

interface AlbyInvoiceResponse {
  payment_hash: string;
  payment_request: string;
  amount: number;
  description?: string;
  expires_at?: string;
  settled?: boolean;
  settled_at?: string | null;
  state?: string;
}

interface AlbyDecodeResponse {
  amount: number;
  description?: string;
  payment_hash: string;
}

export class AlbyClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken.replace(/^Bearer\s+/i, '').trim();
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${ALBY_API}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'factorium-protocol',
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Alby API error ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  }

  async createInvoice(amount: number, description: string, expirySeconds = 3600): Promise<LightningInvoice> {
    const data = await this.request<AlbyInvoiceResponse>('/invoices', {
      method: 'POST',
      body: JSON.stringify({
        amount,
        description: description.slice(0, 200),
        expiry: expirySeconds,
      }),
    });

    return {
      paymentHash: data.payment_hash,
      paymentRequest: data.payment_request,
      amount,
      description,
      expiresAt: data.expires_at || new Date(Date.now() + expirySeconds * 1000).toISOString(),
      status: 'pending',
    };
  }

  async checkInvoice(paymentHash: string): Promise<boolean> {
    try {
      const data = await this.request<AlbyInvoiceResponse>(`/invoices/${paymentHash}`);
      return data.settled === true || data.state === 'SETTLED';
    } catch {
      return false;
    }
  }

  async payInvoice(paymentRequest: string, amount: number, description: string): Promise<{ paymentHash: string }> {
    const data = await this.request<{ payment_hash: string }>('/payments/bolt11', {
      method: 'POST',
      body: JSON.stringify({
        invoice: paymentRequest,
        amount,
        description,
      }),
    });

    return { paymentHash: data.payment_hash };
  }

  async decodeInvoice(paymentRequest: string): Promise<{ amount: number; description: string }> {
    const data = await this.request<AlbyDecodeResponse>(
      `/decode/bolt11/${encodeURIComponent(paymentRequest)}`
    );
    return {
      amount: data.amount,
      description: data.description || '',
    };
  }

  async getBalance(): Promise<number> {
    const data = await this.request<{ balance: number }>('/balance');
    return data.balance;
  }
}
