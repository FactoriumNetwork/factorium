// Verifies that the browser-side signing code embedded in the dashboard
// (src/dashboard/html.ts) produces byte-identical output to the server-side
// trust layer (src/trust/signing.ts).
//
// Strategy: instead of keeping a hand-copied duplicate of the dashboard logic
// in this file (which would silently drift), the dashboard is *rendered* in
// Node, the inline <script> block is extracted, and the functions the browser
// actually runs (sha256Hex, canonicalAttestationPayload, normalizePem,
// signAttestationPayload, supportsEd25519) are pulled out of that script source
// and evaluated here. Extraction uses a marker search plus brace matching, so
// it always tests the code that ships, not a copy.
//
// Extraction constraint: extraction runs against the *rendered* script (the
// bytes the browser receives), so template-literal escapes are already
// resolved. canonicalAttestationPayload and sha256Hex are additionally kept
// free of backslashes, backticks and template placeholders so their logic never
// depends on template escaping; the full-script compile check below catches
// broken escapes anywhere in the emitted script.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  generateVerifierKeypair,
  canonicalAttestationPayload,
  signPayload,
  verifyPayload,
} from '../dist/src/trust/signing.js';
import { renderDashboard } from '../dist/src/dashboard/html.js';

// --- 1. Render the dashboard and pull out the inline script the browser runs ---

const html = renderDashboard({
  agent: { agentId: 'ag_check_1', name: 'Check Bot' },
  apiKey: 'fk_check_key',
  wallet: { balance: 100, ownerType: 'verifier' },
  stats: {},
  openBounties: 0,
  bounties: [],
  myBounties: [],
  myTxns: [],
  myVerifier: {
    id: 'ag_check_1', name: 'Check Verifier', endpoint: 'https://example.com/verify',
    publicKey: 'pem', stakedAmount: 5000, reputationScore: 100, totalAttestations: 0,
    successfulAttestations: 0, disputedAttestations: 0, registeredAt: '2026-01-01', active: true,
  },
  verifiers: [],
});

const scriptStart = html.lastIndexOf('<script>');
const scriptEnd = html.lastIndexOf('</script>');
assert.notEqual(scriptStart, -1, 'rendered dashboard must contain an inline <script> block');
assert.ok(scriptEnd > scriptStart, 'script block must be closed');
const dashboardScript = html.slice(scriptStart + '<script>'.length, scriptEnd);

// The whole emitted script must be parseable JS. This catches template-literal
// escape corruption (e.g. a single backslash swallowing a character).
new Function(dashboardScript);
console.log('ok: dashboard inline script compiles as valid JavaScript');

function extractFunction(source, name) {
  const marker = 'function ' + name + '(';
  let start = source.indexOf(marker);
  assert.notEqual(start, -1, 'expected to find function ' + name + ' in the dashboard script');
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces while extracting ' + name);
}

function loadDashboardFunctions(...names) {
  // One shared scope so the extracted functions can call each other exactly as
  // they do in the browser.
  const probeMatch = dashboardScript.match(/var ED25519_PROBE_PKCS8_B64 = '([^']+)'/);
  assert.ok(probeMatch, 'dashboard script must define the Ed25519 probe key');
  const probeDecl = "var ED25519_PROBE_PKCS8_B64 = '" + probeMatch[1] + "';";
  const bodies = names.map((name) => extractFunction(dashboardScript, name)).join('\n');
  const ret = 'return { ' + names.map((name) => name + ': ' + name).join(', ') + ' };';
  // window is shimmed to the global object; the extracted helpers only use it
  // for feature detection (window.crypto).
  return new Function('window', probeDecl + '\n' + bodies + '\n' + ret)(globalThis);
}

const dash = loadDashboardFunctions(
  'sha256Hex',
  'canonicalAttestationPayload',
  'normalizePem',
  'pemToArrayBuffer',
  'importVerifierSigningKey',
  'signAttestationPayload',
  'supportsEd25519'
);
const dashboardSha256Hex = dash.sha256Hex;
const dashboardCanonicalPayload = dash.canonicalAttestationPayload;
console.log('ok: extracted sha256Hex, canonicalAttestationPayload and the key/signing helpers from the dashboard script');

// --- (a) Browser subjectHash must equal the server's createHash('sha256') ---

const sampleSubjects = [
  'Bitcoin block reward after 2024 halving',
  'Cafe Munchn / Kaffee \u00e9\u00e8 / \u79d1\u5b66\u8a66\u9a13 \u2705',
  'x',
];

for (const subject of sampleSubjects) {
  const browserHex = await dashboardSha256Hex(subject);
  const serverHex = createHash('sha256').update(subject, 'utf8').digest('hex');
  assert.match(browserHex, /^[0-9a-f]{64}$/, 'dashboard hash must be lowercase hex');
  assert.equal(browserHex, serverHex, 'dashboard sha256Hex must equal createHash for: ' + subject);
}
console.log('ok: dashboard sha256Hex byte-matches createHash("sha256") for all sample subjects');

// --- (b) Dashboard canonical payload must byte-equal the server implementation ---

const payloadCases = [
  {
    type: 'fact-check',
    subjectHash: createHash('sha256').update('Bitcoin block reward after 2024 halving').digest('hex'),
    result: '{"verdict":"true","details":"3.125 BTC"}',
    confidence: 0.99,
    price: 5,
    verifierId: 'ag_check_1',
  },
  {
    type: 'content-authenticity',
    subjectHash: createHash('sha256').update('Article: "perpetual motion" \u2014 viraltechdaily.com').digest('hex'),
    result: '{"authentic":false,"reason":"Fabricated. No academic source."}',
    confidence: 0.1 + 0.2, // 0.30000000000000004: exercises full double round-tripping
    price: 123456789012345,
    verifierId: 'ag_verifier_with_underscores_9',
  },
  {
    type: 'custom',
    subjectHash: 'a'.repeat(64),
    result: 'line one\nline two\ttabbed "quotes" \\ backslash / slash',
    confidence: 1,
    price: 0,
    verifierId: 'ag_x',
  },
];

for (const fields of payloadCases) {
  const fromDashboard = dashboardCanonicalPayload(fields);
  const fromServer = canonicalAttestationPayload(fields);
  assert.deepEqual(
    Buffer.from(fromDashboard, 'utf8'),
    Buffer.from(fromServer, 'utf8'),
    'dashboard payload must byte-equal server payload for case: ' + fields.type
  );
}
console.log('ok: dashboard canonical payload byte-equals canonicalAttestationPayload for all cases');

// Numbers must survive the request-body JSON round trip (Express parses the body
// with JSON.parse, the server then signs the parsed values).
{
  const fields = payloadCases[1];
  const body = JSON.parse(JSON.stringify({
    type: fields.type,
    subject: 'some subject',
    result: fields.result,
    resultSummary: 'summary',
    confidence: fields.confidence,
    verifierId: fields.verifierId,
    price: fields.price,
    royaltyPerAccess: 2,
  }));
  const reparsed = canonicalAttestationPayload({
    type: body.type,
    subjectHash: fields.subjectHash,
    result: body.result,
    confidence: body.confidence,
    price: body.price,
    verifierId: body.verifierId,
  });
  assert.equal(dashboardCanonicalPayload(fields), reparsed, 'payload built pre-request must equal payload rebuilt from the parsed body');
  console.log('ok: payload is stable across the JSON request-body round trip');
}

// --- (c) Sign the dashboard payload with the dashboard's own WebCrypto code ---

const { publicKeyPem, privateKeyPem } = generateVerifierKeypair();

for (const fields of payloadCases) {
  const payload = dashboardCanonicalPayload(fields);
  // This runs the exact browser path: PEM -> base64 DER -> importKey('pkcs8',
  // Ed25519) -> subtle.sign -> base64, all extracted from the rendered script.
  const signatureB64 = await dash.signAttestationPayload(privateKeyPem, payload);
  assert.equal(
    verifyPayload(publicKeyPem, payload, signatureB64),
    true,
    'server verifyPayload must accept a WebCrypto signature over the dashboard payload'
  );
  assert.equal(
    verifyPayload(publicKeyPem, canonicalAttestationPayload(fields), signatureB64),
    true,
    'same signature must verify against the server-built payload'
  );
  assert.equal(
    verifyPayload(publicKeyPem, payload + 'tampered', signatureB64),
    false,
    'tampered payload must fail verification'
  );
}
console.log('ok: dashboard signAttestationPayload (WebCrypto) signatures verify against the server implementation');

// Server-side signer must also interoperate with the dashboard payload.
{
  const fields = payloadCases[0];
  const payload = dashboardCanonicalPayload(fields);
  const serverSignature = signPayload(privateKeyPem, payload);
  assert.equal(verifyPayload(publicKeyPem, payload, serverSignature), true, 'server signPayload must verify over the dashboard payload');
  const other = generateVerifierKeypair();
  assert.equal(verifyPayload(other.publicKeyPem, payload, serverSignature), false, 'wrong public key must be rejected');
  console.log('ok: signPayload/verifyPayload round trip over the dashboard payload');
}

// --- Feature detection and PEM paste normalization (dashboard helpers) ---

assert.equal(await dash.supportsEd25519(), true, 'supportsEd25519() must report support on an Ed25519-capable WebCrypto');
assert.equal(dash.normalizePem('not a pem key'), null, 'normalizePem must reject input that is not a PEM block');

const collapsedPem = privateKeyPem.replace(/\n/g, ''); // PEM pasted through a single-line field
const renormalized = dash.normalizePem(collapsedPem);
assert.ok(renormalized, 'normalizePem must recover a PEM whose newlines were stripped');
const normalizedPayload = dashboardCanonicalPayload(payloadCases[0]);
const normalizedSig = await dash.signAttestationPayload(renormalized, normalizedPayload);
assert.equal(
  verifyPayload(publicKeyPem, normalizedPayload, normalizedSig),
  true,
  'signature must verify after round-tripping the private key through normalizePem'
);
console.log('ok: Ed25519 feature detection and PEM paste normalization work as the dashboard uses them');

console.log('check-dashboard-signing: all checks passed');
