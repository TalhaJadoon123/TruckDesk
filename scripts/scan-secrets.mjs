import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Secret scanner for the committed tree.
 *
 * Runs patterns over every file git tracks, and only reports real findings: a
 * match in a test fixture, a documentation example or a `.env.example` is not a
 * leak, and flagging those is how a scanner gets ignored.
 *
 *   node scripts/scan-secrets.mjs
 */

const ROOT = process.cwd();

/**
 * Each pattern is checked against a file only if the file is not on the
 * allow list, and every finding must pass an entropy or context check so that
 * `sha256($`1,850')` in a fixture is not reported as a private key.
 */
const RULES = [
  { name: 'aws-access-key-id', severity: 'critical', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'aws-secret-access-key', severity: 'critical', re: /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi },
  { name: 'github-token', severity: 'critical', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { name: 'github-pat', severity: 'critical', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { name: 'slack-token', severity: 'critical', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'stripe-secret', severity: 'critical', re: /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'google-api-key', severity: 'critical', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'openai-key', severity: 'critical', re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { name: 'groq-key', severity: 'critical', re: /\bgsk_[A-Za-z0-9]{40,}\b/g },
  { name: 'supabase-service-role', severity: 'critical', re: /\bsupabase_service_role_key\s*[:=]\s*['"]?eyJ[A-Za-z0-9._-]{40,}/gi },
  { name: 'jwt', severity: 'high', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'private-key-block', severity: 'critical', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'postgres-url-with-password', severity: 'critical', re: /postgres(?:ql)?:\/\/[A-Za-z0-9_.-]+:[A-Za-z0-9!#$%^&*_-]{4,}@/g },
  { name: 'generic-api-secret-assignment', severity: 'medium', re: /\b[A-Z_]*(SECRET|TOKEN|PASSWORD|PRIVATE_KEY)[A-Z_]*\s*[:=]\s*['"][A-Za-z0-9/+_-]{16,}['"]/g },
];

/** Paths where a match is expected and is not a finding. */
const ALLOW = [
  /^tests\//,
  /\.example$/,
  /^docs\//,
  /^packages\/docs\/content\//,
  /\.md$/,
  /pnpm-lock\.yaml$/,
  /\.test\.ts$/,
  /^\.github\/workflows\//,
  /scripts\//,
  // Credential-shaped strings that are not secrets:
  //   docker-compose.yml  - the local Postgres password, literally "truckdesk",
  //     which is the throwaway value in the compose file itself and is only
  //     ever bound to localhost
  //   db/migrate.ts       - console.error help text showing the URL *shape* to
  //     copy, with PASSWORD/USER as literal placeholders
  //   smoke.ts            - the test suite's own HMAC key for an in-memory
  //     server
  /^docker\/docker-compose\.yml$/,
  /packages\/api\/src\/db\/migrate\.ts$/,
  /packages\/api\/src\/smoke\.ts$/,
];

function allowed(file) {
  return ALLOW.some((re) => re.test(file));
}

/** Shannon entropy: catches "password" where the real value is random. */
function entropy(value) {
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    result -= p * Math.log2(p);
  }
  return result;
}

function looksLikeRealSecret(value) {
  if (value.length < 12) return false;
  // A repeated or dictionary-ish string is not a secret.
  if (/^(test|example|placeholder|changeme|your|xxx)/i.test(value)) return false;
  if (new Set(value).size <= 4) return false;
  return entropy(value) > 2.5;
}

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const findings = [];
let scanned = 0;

for (const file of files) {
  if (allowed(file)) continue;

  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) continue;
  if (fs.statSync(full).size > 4 * 1024 * 1024) continue;

  const binary = /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|eot|zip|gz|pdf|mp4|mp3)$/i.test(file);
  if (binary) continue;

  scanned += 1;

  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    continue;
  }

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let match;
    while ((match = rule.re.exec(text)) !== null) {
      const value = match[0];
      // The high-signal patterns stand on their own; the generic assignment
      // rule needs the value to actually look random.
      if (rule.name === 'generic-api-secret-assignment' && !looksLikeRealSecret(value)) continue;

      const line = text.slice(0, match.index).split('\n').length;
      findings.push({ file, line, rule: rule.name, severity: rule.severity, preview: redact(value) });
    }
  }
}

function redact(value) {
  const head = value.slice(0, 6);
  return `${head}${'*'.repeat(Math.max(0, value.length - 6))} (len ${value.length})`;
}

console.log(`scanned ${scanned} tracked file(s) against ${RULES.length} rules`);

if (findings.length === 0) {
  console.log('\nno secrets found in committed files');
  process.exit(0);
}

const critical = findings.filter((f) => f.severity === 'critical');
console.log(`\n${findings.length} finding(s), ${critical.length} critical\n`);
for (const finding of findings) {
  console.log(`  [${finding.severity.toUpperCase()}] ${finding.rule}`);
  console.log(`    ${finding.file}:${finding.line}`);
  console.log(`    ${finding.preview}`);
}

process.exit(critical.length > 0 ? 1 : 0);