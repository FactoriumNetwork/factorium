const ALBY_API = process.env.ALBY_HUB_URL || 'https://api.getalby.com';

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
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Alby API error ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  }

  async createInvoice(amount: number, description: string, expirySeconds = 3600) {
    const data = await this.request<any>('/invoices', {
      method: 'POST',
      body: JSON.stringify({
        amount,
        description: description.slice(0, 200),
      }),
    });

    return {
      paymentHash: data.paymentHash || data.payment_hash,
      paymentRequest: data.invoice || data.payment_request,
      amount,
      description,
      expiresAt: data.expiresAt || data.expires_at || new Date(Date.now() + expirySeconds * 1000).toISOString(),
      status: data.state || data.status || 'pending',
    };
  }

  async checkInvoice(paymentHash: string): Promise<boolean> {
    try {
      const data = await this.request<any>(`/invoices/${paymentHash}`);
      return data.settled === true || data.state === 'SETTLED' || data.status === 'completed';
    } catch {
      return false;
    }
  }

  async payInvoice(paymentRequest: string, amount: number, description: string): Promise<{ paymentHash: string }> {
    const data = await this.request<any>('/payments/bolt11', {
      method: 'POST',
      body: JSON.stringify({
        invoice: paymentRequest,
        amount,
        description,
      }),
    });

    return { paymentHash: data.paymentHash || data.payment_hash || data.id };
  }

  async decodeInvoice(paymentRequest: string): Promise<{ amount: number; description: string }> {
    const data = await this.request<any>(
      `/decode/bolt11/${encodeURIComponent(paymentRequest)}`
    );
    return {
      amount: data.amount || 0,
      description: data.description || data.memo || '',
    };
  }

  async getBalance(): Promise<number> {
    const data = await this.request<any>('/balance');
    return typeof data.balance === 'number' ? data.balance : (data.balanceMsat || 0) / 1000;
  }
}
