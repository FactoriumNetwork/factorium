#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { generateKeyPairSync } from "crypto";
import { canonicalAttestationPayload, signPayload } from "../dist/src/trust/signing.js";
import { hashSubject } from "../dist/src/registry/attestations.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const credsDir = join(root, "verifiers", ".npm-audit");
const credsPath = join(credsDir, "credentials.json");

const DEFAULT_BASE_URL = "https://factorium.network";
const BASE_URL = (process.env.BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
const AGENT_NAME = process.env.AGENT_NAME || "NPM Audit (reference verifier)";

function printHelp() {
  console.log(`NPM Audit Verifier for Factorium

Usage:
  node tools/npm-audit-verifier.mjs <npm-spec> [<npm-spec> ...] [--base-url <url>] [--agent-name <name>]

Arguments:
  <npm-spec>    One or more npm package specs like npm:lodash@4.17.15 or lodash@4.17.15
                Duplicates are ignored; per-package failures do not stop the batch.

Environment:
  BASE_URL      Factorium API base URL (default: https://factorium.network)
  AGENT_NAME    Verifier/agent name (default: "NPM Audit (reference verifier)")

Notes:
- Idempotent: stores credentials in verifiers/.npm-audit/credentials.json (gitignored)
- Uses the npm registry security advisories bulk API for real vulnerability data
- Signs with ed25519 using the server's canonical payload format
- Works against both new (trust-layer) and older servers
`);
}

function ensureGitignore() {
  const gitignorePath = join(root, ".gitignore");
  let content = "";
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, "utf8");
  }
  if (!content.includes("verifiers/.npm-audit/")) {
    content += (content.endsWith("\n") ? "" : "\n") + "verifiers/.npm-audit/\n";
    writeFileSync(gitignorePath, content);
    console.log("[gitignore] Added verifiers/.npm-audit/");
  }
}

async function reportPostgres() {
  try {
    try {
      const { execSync } = await import("child_process");
      const out = execSync("powershell -Command \"Get-Command psql -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source\"", { encoding: "utf8", timeout: 3000 });
      if (out.trim()) console.log("[postgres] psql found: " + out.trim());
      else console.log("[postgres] psql not found in PATH");
    } catch {
      console.log("[postgres] psql not found in PATH");
    }
    try {
      const { execSync } = await import("child_process");
      const out = execSync("powershell -Command \"Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Format-Table -AutoSize | Out-String\"", { encoding: "utf8", timeout: 3000 });
      if (out.trim()) console.log("[postgres] services:\n" + out.trim());
      else console.log("[postgres] No local PostgreSQL services found");
    } catch {
      console.log("[postgres] No local PostgreSQL services found");
    }
  } catch {
    console.log("[postgres] Could not check");
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const specs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    if (a === "--base-url" && args[i+1]) { process.env.BASE_URL = args[++i]; continue; }
    if (a === "--agent-name" && args[i+1]) { process.env.AGENT_NAME = args[++i]; continue; }
    if (!a.startsWith("-")) { specs.push(a); continue; }
  }
  return [...new Set(specs)];
}

function parseSpec(spec) {
  if (!spec) throw new Error("Missing npm package spec");
  if (spec.startsWith("npm:")) spec = spec.slice(4);
  if (spec.startsWith("@")) {
    const at = spec.lastIndexOf("@");
    if (at > 0) return { pkg: spec.slice(0, at), version: spec.slice(at + 1) };
    return { pkg: spec, version: "latest" };
  }
  if (spec.includes("@")) {
    const at = spec.lastIndexOf("@");
    if (at > 0) return { pkg: spec.slice(0, at), version: spec.slice(at + 1) };
  }
  return { pkg: spec, version: "latest" };
}

async function httpJson(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { ok: res.ok, status: res.status, json, text };
}

function generateEd25519Keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

async function credsAreValid(creds) {
  try {
    const me = await httpJson("GET", BASE_URL + "/me", undefined, {
      "X-Agent-Id": creds.agentId,
      "X-Api-Key": creds.apiKey,
    });
    return me.ok;
  } catch {
    return false;
  }
}

async function loadOrCreateCreds() {
  if (existsSync(credsPath)) {
    let existing = null;
    try {
      existing = JSON.parse(readFileSync(credsPath, "utf8"));
    } catch {}
    if (existing) {
      if (!(existing.agentId && existing.apiKey && existing.verifierId && existing.privateKeyPem)) {
        throw new Error("verifiers/.npm-audit/credentials.json is missing required fields. Move it aside and re-run.");
      }
      console.log("[creds] Loaded from verifiers/.npm-audit/credentials.json");
      if (!(await credsAreValid(existing))) {
        throw new Error(
          "Saved credentials are no longer valid on " + BASE_URL + " (GET /me rejected them). " +
          "The agent or API key may have been removed server-side. " +
          "Move verifiers/.npm-audit/credentials.json aside and re-run to register a new agent and verifier."
        );
      }
      return existing;
    }
  }
  mkdirSync(credsDir, { recursive: true });
  console.log("[creds] Creating new agent + verifier...");

  const signup = await httpJson("POST", BASE_URL + "/signup", { name: AGENT_NAME });
  if (!signup.ok) throw new Error("Signup failed: " + signup.status + " " + JSON.stringify(signup.json));
  const { agentId, apiKey } = signup.json;
  console.log("[signup] agentId: " + agentId);

  let reg = await httpJson("POST", BASE_URL + "/verifiers", {
    name: AGENT_NAME,
    endpoint: "https://example.com/npm-audit-verifier",
    initialStake: 100
  }, { "X-Agent-Id": agentId, "X-Api-Key": apiKey });

  let privateKeyPem, verifierId;
  if (reg.ok) {
    const data = reg.json;
    if (data.privateKeyPem) {
      privateKeyPem = data.privateKeyPem;
      verifierId = data.id || agentId;
      console.log("[verifier] Registered (server-generated keypair)");
    } else {
      throw new Error("Unexpected verifier response");
    }
  } else {
    const kp = generateEd25519Keypair();
    reg = await httpJson("POST", BASE_URL + "/verifiers", {
      name: AGENT_NAME,
      endpoint: "https://example.com/npm-audit-verifier",
      publicKey: kp.publicKeyPem,
      initialStake: 100
    }, { "X-Agent-Id": agentId, "X-Api-Key": apiKey });
    if (!reg.ok) throw new Error("Verifier registration failed: " + reg.status + " " + JSON.stringify(reg.json));
    privateKeyPem = kp.privateKeyPem;
    verifierId = reg.json.id || agentId;
    console.log("[verifier] Registered (local keypair)");
  }

  const creds = { agentId, apiKey, verifierId, privateKeyPem, baseUrl: BASE_URL, name: AGENT_NAME };
  if (!(await credsAreValid(creds))) {
    throw new Error("Freshly created credentials do not authenticate on " + BASE_URL + " (GET /me rejected them). Not saving; check the server's auth and database state.");
  }
  writeFileSync(credsPath, JSON.stringify(creds, null, 2));
  console.log("[creds] Saved to verifiers/.npm-audit/credentials.json");
  return creds;
}

async function queryAdvisories(pkg, version) {
  const meta = await fetch("https://registry.npmjs.org/" + pkg.replace("/", "%2f") + "/" + version);
  if (meta.status === 404) throw new Error("Package version not found on npm: " + pkg + "@" + version);
  const res = await fetch("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ [pkg]: [version === "latest" ? "*" : version] }),
  });
  if (!res.ok) throw new Error("Advisory API returned " + res.status);
  const body = await res.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Unexpected advisory API response");
  return body;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) { printHelp(); return; }
  ensureGitignore();
  console.log("[config] BASE_URL: " + BASE_URL);
  await reportPostgres();
  const specs = parseArgs(process.argv);
  if (specs.length === 0) throw new Error("Missing npm package spec (try --help)");

  const creds = await loadOrCreateCreds();
  console.log("[creds] Using verifierId: " + creds.verifierId);

  const results = [];
  for (const spec of specs) {
    try {
      results.push(await attestOne(spec, creds));
    } catch (e) {
      results.push({ ok: false, subject: spec, error: e.message });
    }
  }

  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log((r.ok ? "ok    " : "FAIL  ") + r.subject + " -> " + (r.ok ? r.id : r.error));
  }
  const created = results.filter(r => r.ok).length;
  console.log(created + "/" + results.length + " attestations created");
  if (created === 0) process.exitCode = 1;
}

async function attestOne(spec, creds) {
  const { pkg, version } = parseSpec(spec);
  console.log("\n[target] npm:" + pkg + "@" + version);

  console.log("[advisory] Querying npm registry security advisories...");
  const adv = await queryAdvisories(pkg, version);
  const list = adv[pkg] || [];
  const vulnerable = list.length > 0;
  const advisories = [];
  for (const a of list) {
    advisories.push({
      id: a.id || (a.cves && a.cves[0]) || a.github_advisory_id || String(a.id),
      cves: a.cves || [],
      severity: a.severity,
      title: a.title
    });
  }
  let resultSummary;
  if (vulnerable) {
    const counts = {};
    for (const a of advisories) {
      const k = a.severity || "unknown";
      counts[k] = (counts[k] || 0) + 1;
    }
    const parts = Object.entries(counts).map(([k, v]) => k + ": " + v).join(", ");
    resultSummary = "Vulnerable to " + advisories.length + " advisory/advisories (" + parts + ") in npm registry data for " + pkg + "@" + version + ".";
    if (resultSummary.length > 500) resultSummary = resultSummary.slice(0, 497) + "...";
  } else {
    resultSummary = "No known advisories found in npm registry security advisories for " + pkg + "@" + version + ".";
  }
  const resultObj = { vulnerable, advisories, tool: "npm-audit-verifier", apiSource: "registry.npmjs.org", checkedAt: new Date().toISOString() };
  const result = JSON.stringify(resultObj);
  const confidence = 1.0;
  const price = 10;
  const royaltyPerAccess = 0;
  const expiresInSeconds = null;
  const metadata = { tool: "npm-audit-verifier", apiSource: "registry.npmjs.org", checkedAt: new Date().toISOString() };

  console.log("[advisory] vulnerable: " + vulnerable + ", count: " + advisories.length);
  if (advisories[0]) console.log("[advisory] first: " + advisories[0].id + " " + advisories[0].severity);

  const subject = "npm:" + pkg + "@" + version;
  const subjectHashVal = hashSubject(subject);
  console.log("[sign] subjectHash: " + subjectHashVal.slice(0,16) + "...");

  const payload = canonicalAttestationPayload({
    type: "code-audit",
    subjectHash: subjectHashVal,
    result,
    confidence,
    price,
    verifierId: creds.verifierId,
  });
  const signature = signPayload(creds.privateKeyPem, payload);
  console.log("[sign] signed with ed25519");

  const attBody = {
    type: "code-audit",
    subject,
    result,
    resultSummary,
    confidence,
    verifierId: creds.verifierId,
    price,
    signature,
    royaltyPerAccess,
    expiresInSeconds,
    metadata,
  };

  console.log("[submit] POST /attestations...");
  const sub = await httpJson("POST", BASE_URL + "/attestations", attBody, { "X-Agent-Id": creds.agentId, "X-Api-Key": creds.apiKey });
  if (!sub.ok) {
    console.error("[submit] FAILED: " + sub.status);
    console.error(JSON.stringify(sub.json));
    return { ok: false, subject, error: sub.status + " " + JSON.stringify(sub.json) };
  }
  const att = sub.json;
  console.log("[submit] created attestation id: " + att.id);

  try {
    const v = await httpJson("GET", BASE_URL + "/attestations/" + att.id + "/verify");
    console.log("[verify] GET /attestations/:id/verify: " + v.status + " " + JSON.stringify(v.json));
  } catch (e) {
    console.log("[verify] GET /attestations/:id/verify: error " + e.message);
  }
  try {
    const g = await httpJson("GET", BASE_URL + "/attestations/" + att.id);
    console.log("[get] GET /attestations/:id: " + g.status + " " + (g.ok ? "ok" : "failed"));
  } catch (e) {
    console.log("[get] GET /attestations/:id: error " + e.message);
  }
  return { ok: true, subject, id: att.id };
}

main().catch(e => {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
});
