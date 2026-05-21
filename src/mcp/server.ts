import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import {
  submitAttestation,
  queryAttestations,
  purchaseAttestation,
  getAttestation,
  disputeAttestation,
  hashSubject,
} from '../registry/attestations.js';
import {
  registerVerifier,
  getVerifier,
  listVerifiers,
  stake,
  slash,
  getTopVerifiers,
} from '../registry/verifiers.js';
import { getMarketplaceStats } from '../marketplace/marketplace.js';
import {
  AttestationSubmissionSchema,
  VerifierRegistrationSchema,
  AttestationQuerySchema,
  DisputeSchema,
} from '../types/index.js';
import {
  getOrCreateWallet,
  getWallet,
  createDepositInvoice,
  confirmDeposit,
  withdrawFunds,
} from '../payments/wallets.js';
import { isLightningConfigured } from '../payments/provider.js';

const TOOLS: Tool[] = [
  {
    name: 'query_attestation',
    description:
      'Search the attestation marketplace for existing verifications. Use before re-running expensive compute. Returns attestations sorted by confidence and price.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description:
            'Attestation type: content-authenticity, identity-verification, document-validation, deepfake-detection, code-audit, fact-check, or custom',
        },
        subject: {
          type: 'string',
          description: 'The subject to search for (URL, hash, identifier, content)',
        },
        subjectHash: {
          type: 'string',
          description: 'Pre-computed SHA-256 hash of the subject',
        },
        verifierId: {
          type: 'string',
          description: 'Filter by specific verifier ID',
        },
        minConfidence: {
          type: 'number',
          description: 'Minimum confidence score (0-1)',
        },
        maxPrice: {
          type: 'number',
          description: 'Maximum price in sats',
        },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
    },
  },
  {
    name: 'buy_attestation',
    description:
      'Purchase access to a verified attestation. Transfers payment to the verifier minus 10% marketplace fee. Returns the full attestation data.',
    inputSchema: {
      type: 'object',
      properties: {
        attestationId: {
          type: 'string',
          description: 'The ID of the attestation to purchase',
        },
        buyerId: {
          type: 'string',
          description: 'Your agent/buyer identifier',
        },
      },
      required: ['attestationId', 'buyerId'],
    },
  },
  {
    name: 'register_verifier',
    description:
      'Register as a new verifier on the marketplace. Verifiers stake sats as reputation collateral and earn revenue when their attestations are purchased.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Verifier name' },
        endpoint: {
          type: 'string',
          description: 'Verifier API endpoint for verification requests',
        },
        publicKey: { type: 'string', description: 'Public key for signature verification' },
        initialStake: {
          type: 'number',
          description: 'Initial stake in sats for reputation collateral',
        },
      },
      required: ['name', 'endpoint', 'publicKey', 'initialStake'],
    },
  },
  {
    name: 'submit_attestation',
    description:
      'Submit a new attestation to the marketplace. Other agents can discover and purchase this instead of re-running verification. Requires 10x stake.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description:
            'Attestation type: content-authenticity, identity-verification, document-validation, deepfake-detection, code-audit, fact-check, or custom',
        },
        subject: {
          type: 'string',
          description: 'What is being attested (URL, hash, text identifier)',
        },
        result: {
          type: 'string',
          description: 'The full verification result (JSON string or structured data)',
        },
        resultSummary: {
          type: 'string',
          description: 'Short summary of the result (max 500 chars)',
        },
        confidence: {
          type: 'number',
          description: 'Confidence score 0-1',
        },
        verifierId: {
          type: 'string',
          description: 'Your verifier ID',
        },
        price: {
          type: 'number',
          description: 'Price in sats per access',
        },
        royaltyPerAccess: {
          type: 'number',
          description: 'Ongoing royalty per access (default 0, max 10% of price)',
        },
        expiresInSeconds: {
          type: 'number',
          description: 'Seconds until this attestation expires (null = never)',
        },
        metadata: {
          type: 'object',
          description: 'Additional metadata about the attestation',
        },
      },
      required: ['type', 'subject', 'result', 'resultSummary', 'confidence', 'verifierId', 'price'],
    },
  },
  {
    name: 'check_verifier_reputation',
    description:
      'Check the reputation and stake of a verifier before trusting their attestations.',
    inputSchema: {
      type: 'object',
      properties: {
        verifierId: {
          type: 'string',
          description: 'Verifier ID to check',
        },
      },
      required: ['verifierId'],
    },
  },
  {
    name: 'list_verifiers',
    description:
      'List all active verifiers on the marketplace, sorted by reputation score.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max results (default 50)',
        },
      },
    },
  },
  {
    name: 'dispute_attestation',
    description:
      'File a dispute against an attestation you believe is incorrect. Successful disputes reduce verifier reputation and may slash their stake.',
    inputSchema: {
      type: 'object',
      properties: {
        attestationId: {
          type: 'string',
          description: 'The ID of the attestation to dispute',
        },
        reason: {
          type: 'string',
          description: 'Reason for the dispute',
        },
        evidence: {
          type: 'string',
          description: 'Supporting evidence for the dispute',
        },
      },
      required: ['attestationId', 'reason'],
    },
  },
  {
    name: 'get_marketplace_stats',
    description:
      'Get overall marketplace statistics: total attestations, verifiers, transaction volume, fees collected, and top verifiers.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'create_deposit_invoice',
    description:
      'Create a Lightning Network invoice to deposit funds into your marketplace wallet. Returns a BOLT11 invoice. Pay it with any Lightning wallet.',
    inputSchema: {
      type: 'object',
      properties: {
        ownerId: {
          type: 'string',
          description: 'Your verifier or buyer ID',
        },
        ownerType: {
          type: 'string',
          description: "'verifier' or 'buyer'",
        },
        amount: {
          type: 'number',
          description: 'Amount in satoshis to deposit',
        },
        memo: {
          type: 'string',
          description: 'Description for the deposit',
        },
      },
      required: ['ownerId', 'ownerType', 'amount', 'memo'],
    },
  },
  {
    name: 'confirm_deposit',
    description:
      'Confirm a Lightning deposit has been paid. Credits funds to your wallet balance.',
    inputSchema: {
      type: 'object',
      properties: {
        paymentHash: {
          type: 'string',
          description: 'The payment hash from create_deposit_invoice',
        },
      },
      required: ['paymentHash'],
    },
  },
  {
    name: 'check_balance',
    description: 'Check your wallet balance in the marketplace.',
    inputSchema: {
      type: 'object',
      properties: {
        ownerId: {
          type: 'string',
          description: 'Your verifier or buyer ID',
        },
      },
      required: ['ownerId'],
    },
  },
  {
    name: 'withdraw_funds',
    description:
      'Withdraw earnings to an external Lightning wallet. Provide a BOLT11 invoice.',
    inputSchema: {
      type: 'object',
      properties: {
        ownerId: {
          type: 'string',
          description: 'Your verifier or buyer ID',
        },
        invoice: {
          type: 'string',
          description: 'A Lightning Network invoice (BOLT11) from your wallet',
        },
        amount: {
          type: 'number',
          description: 'Amount in sats to withdraw (must match the invoice)',
        },
      },
      required: ['ownerId', 'invoice', 'amount'],
    },
  },
];

function createServer(): Server {
  const server = new Server(
    { name: 'factorium-attestation-marketplace', version: '1.0.7' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'query_attestation': {
          const validated = AttestationQuerySchema.parse(args ?? {});
          const result = queryAttestations(validated);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        case 'buy_attestation': {
          const { attestationId, buyerId } = args as { attestationId: string; buyerId: string };
          const result = purchaseAttestation(attestationId, buyerId);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                transactionId: result.transactionId,
                attestation: result.attestation,
                message: `Purchased attestation for ${result.attestation.price} sats.`,
              }, null, 2),
            }],
          };
        }
        case 'register_verifier': {
          const validated = VerifierRegistrationSchema.parse(args ?? {});
          const verifier = registerVerifier(validated);
          return { content: [{ type: 'text', text: JSON.stringify(verifier, null, 2) }] };
        }
        case 'submit_attestation': {
          const validated = AttestationSubmissionSchema.parse(args ?? {});
          const { verifierId, ...rest } = validated;
          const verifier = getVerifier(verifierId);
          if (!verifier) throw new Error(`Verifier not found: ${verifierId}`);
          if (!verifier.active) throw new Error(`Verifier is inactive: ${verifierId}`);
          if (verifier.stakedAmount < validated.price * 10) {
            throw new Error(`Insufficient stake. Need ${validated.price * 10}, have ${verifier.stakedAmount}.`);
          }
          const attestation = submitAttestation({ ...rest, verifierId });
          return { content: [{ type: 'text', text: JSON.stringify(attestation, null, 2) }] };
        }
        case 'check_verifier_reputation': {
          const { verifierId } = args as { verifierId: string };
          const verifier = getVerifier(verifierId);
          if (!verifier) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: `Verifier not found: ${verifierId}` }) }] };
          }
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                id: verifier.id,
                name: verifier.name,
                reputationScore: verifier.reputationScore,
                stakedAmount: verifier.stakedAmount,
                totalAttestations: verifier.totalAttestations,
                successfulAttestations: verifier.successfulAttestations,
                disputedAttestations: verifier.disputedAttestations,
                disputeRate: verifier.totalAttestations > 0
                  ? (verifier.disputedAttestations / verifier.totalAttestations).toFixed(4)
                  : '0',
              }, null, 2),
            }],
          };
        }
        case 'list_verifiers': {
          const { limit } = (args ?? {}) as { limit?: number };
          const verifiers = listVerifiers(true).slice(0, limit || 50);
          return { content: [{ type: 'text', text: JSON.stringify(verifiers, null, 2) }] };
        }
        case 'dispute_attestation': {
          const validated = DisputeSchema.parse(args ?? {});
          const updated = disputeAttestation(validated.attestationId, validated.reason);
          return { content: [{ type: 'text', text: JSON.stringify({ message: 'Dispute filed', attestation: updated }, null, 2) }] };
        }
        case 'get_marketplace_stats': {
          const stats = getMarketplaceStats();
          return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
        }
        case 'create_deposit_invoice': {
          const { ownerId, ownerType, amount, memo } = args as {
            ownerId: string; ownerType: 'verifier' | 'buyer'; amount: number; memo: string;
          };
          const invoice = await createDepositInvoice(ownerId, ownerType, amount, memo);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                message: `Lightning invoice created for ${amount} sats.`,
                invoice,
                instructions: 'Pay this BOLT11 invoice, then call confirm_deposit with the payment_hash.',
              }, null, 2),
            }],
          };
        }
        case 'confirm_deposit': {
          const { paymentHash } = args as { paymentHash: string };
          const result = await confirmDeposit(paymentHash);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        case 'check_balance': {
          const { ownerId } = args as { ownerId: string };
          const wallet = getWallet(ownerId);
          if (!wallet) {
            getOrCreateWallet(ownerId, 'buyer');
            return {
              content: [{ type: 'text', text: JSON.stringify({ ownerId, balance: 0, lightningConfigured: isLightningConfigured() }, null, 2) }],
            };
          }
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ ownerId, balance: wallet.balance, lightningConfigured: isLightningConfigured(), hasLNBitsWallet: !!wallet.lnbitsWalletId, }, null, 2),
            }],
          };
        }
        case 'withdraw_funds': {
          const { ownerId, invoice, amount } = args as { ownerId: string; invoice: string; amount: number };
          const result = await withdrawFunds(ownerId, invoice, amount);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }) }],
        isError: true,
      };
    }
  });

  return server;
}

let sharedServer: Server | null = null;

export function getOrCreateMCPServer(): Server {
  if (!sharedServer) {
    sharedServer = createServer();
  }
  return sharedServer;
}

export async function startMCPServer(): Promise<void> {
  const server = getOrCreateMCPServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function createMCPHttpTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
}

export async function createAndConnectMCPTransport(transport: StreamableHTTPServerTransport, server?: Server): Promise<void> {
  const srv = server || getOrCreateMCPServer();
  await srv.connect(transport);
}
