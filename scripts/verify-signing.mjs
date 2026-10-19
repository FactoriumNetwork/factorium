import { strict as assert } from 'node:assert';
import {
  generateVerifierKeypair,
  canonicalAttestationPayload,
  signPayload,
  verifyPayload,
} from '../dist/src/trust/signing.js';

const { publicKeyPem, privateKeyPem } = generateVerifierKeypair();

const fields = {
  type: 'fact-check',
  subjectHash: 'a'.repeat(64),
  result: '{"verdict":"true"}',
  confidence: 0.95,
  price: 10,
  verifierId: 'smoke-verifier',
};

const payload = canonicalAttestationPayload(fields);

// Canonical form: keys sorted alphabetically, no whitespace.
assert.equal(
  payload,
  '{"confidence":0.95,"price":10,"result":"{\\"verdict\\":\\"true\\"}","subjectHash":"' + 'a'.repeat(64) + '","type":"fact-check","verifierId":"smoke-verifier"}',
  'canonical payload should be sorted JSON with no whitespace'
);
console.log('ok: canonical payload is deterministic sorted JSON');

const signature = signPayload(privateKeyPem, payload);
assert.equal(verifyPayload(publicKeyPem, payload, signature), true, 'valid signature should verify');
console.log('ok: valid signature verifies');

const tampered = canonicalAttestationPayload({ ...fields, confidence: 0.5 });
assert.equal(verifyPayload(publicKeyPem, tampered, signature), false, 'tampered payload should not verify');
console.log('ok: tampered payload rejected');

assert.equal(verifyPayload('this is not a pem', payload, signature), false, 'garbage PEM should return false');
console.log('ok: garbage PEM returns false without throwing');

assert.equal(verifyPayload(publicKeyPem, payload, '!!!not-base64!!!'), false, 'garbage signature should return false');
console.log('ok: garbage signature returns false without throwing');

const other = generateVerifierKeypair();
assert.equal(verifyPayload(other.publicKeyPem, payload, signature), false, 'wrong key should not verify');
console.log('ok: wrong public key rejected');

console.log('verify-signing: all checks passed');
