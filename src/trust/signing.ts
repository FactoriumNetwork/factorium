import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'crypto';

export function generateVerifierKeypair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// Deterministic JSON over exactly the fields a verifier knows at signing time.
// Server-generated fields (id, createdAt) are deliberately excluded.
export function canonicalAttestationPayload(fields: {
  type: string;
  subjectHash: string;
  result: string;
  confidence: number;
  price: number;
  verifierId: string;
}): string {
  return JSON.stringify({
    confidence: fields.confidence,
    price: fields.price,
    result: fields.result,
    subjectHash: fields.subjectHash,
    type: fields.type,
    verifierId: fields.verifierId,
  });
}

export function signPayload(privateKeyPem: string, payload: string): string {
  const key = createPrivateKey(privateKeyPem);
  return sign(null, Buffer.from(payload, 'utf8'), key).toString('base64');
}

export function verifyPayload(publicKeyPem: string, payload: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    const signature = Buffer.from(signatureB64, 'base64');
    return verify(null, Buffer.from(payload, 'utf8'), key, signature);
  } catch {
    return false;
  }
}
