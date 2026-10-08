import type { Severity } from '@projecthub/contracts';
import type { RawFinding } from './types.js';

interface SecretRule {
  id: string;
  title: string;
  severity: Severity;
  pattern: RegExp;
  /** Optional check on the matched value to cut false positives. */
  validate?: (match: string) => boolean;
}

const PLACEHOLDER = /(x{4,}|\*{3,}|<[^>]+>|\$\{[^}]+\}|your[_-]?|example|changeme|dummy|placeholder|test|sample|redacted|\.\.\.)/i;

const RULES: SecretRule[] = [
  { id: 'aws-access-key', title: 'AWS erişim anahtarı', severity: 'critical', pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    id: 'aws-secret-key',
    title: 'AWS gizli anahtarı',
    severity: 'critical',
    pattern: /aws_?secret_?access_?key["'\s:=]+["']?([A-Za-z0-9/+=]{40})\b/i,
  },
  { id: 'github-token', title: 'GitHub erişim tokeni', severity: 'critical', pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82})\b/ },
  { id: 'gitlab-token', title: 'GitLab erişim tokeni', severity: 'critical', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'stripe-live-key', title: 'Stripe canlı gizli anahtarı', severity: 'critical', pattern: /\b(sk|rk)_live_[0-9a-zA-Z]{20,}\b/ },
  { id: 'openai-key', title: 'OpenAI API anahtarı', severity: 'critical', pattern: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/, validate: (m) => !m.startsWith('sk-ant-') },
  { id: 'anthropic-key', title: 'Anthropic API anahtarı', severity: 'critical', pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/ },
  { id: 'google-api-key', title: 'Google API anahtarı', severity: 'high', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'slack-token', title: 'Slack tokeni', severity: 'high', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { id: 'slack-webhook', title: 'Slack webhook adresi', severity: 'medium', pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/ },
  { id: 'sendgrid-key', title: 'SendGrid API anahtarı', severity: 'high', pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { id: 'twilio-key', title: 'Twilio API anahtarı', severity: 'high', pattern: /\bSK[0-9a-fA-F]{32}\b/ },
  { id: 'npm-token', title: 'npm erişim tokeni', severity: 'high', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  {
    id: 'private-key',
    title: 'Özel anahtar (private key)',
    severity: 'critical',
    pattern: /-----BEGIN ((RSA|EC|DSA|OPENSSH|PGP|ENCRYPTED) )?PRIVATE KEY( BLOCK)?-----/,
  },
  {
    id: 'database-url-password',
    title: 'Veritabanı bağlantısında şifre',
    severity: 'high',
    pattern: /\b(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|redis|amqp):\/\/[^:\s/@'"]+:([^@\s'"]{4,})@[^\s'"]+/i,
    validate: (m) => {
      const pw = /:\/\/[^:]+:([^@]+)@/.exec(m)?.[1] ?? '';
      return !PLACEHOLDER.test(pw) && !/^(pass(word)?|pw|secret|postgres|root|user)$/i.test(pw);
    },
  },
  {
    id: 'hardcoded-credential',
    title: 'Kod içinde şifre / anahtar',
    severity: 'high',
    pattern: /\b([A-Za-z_]*(password|passwd|pwd|secret|api_?key|apikey|access_?token|auth_?token|client_?secret|private_?key))\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i,
    validate: (m) => {
      const value = /[:=]\s*["']([^"']+)["']/.exec(m)?.[1] ?? '';
      if (PLACEHOLDER.test(value)) return false;
      if (/^(process\.env|import\.meta|env\(|getenv|os\.environ|config\(|true|false|null|undefined)/i.test(value)) return false;
      // Require some entropy: mixed character classes.
      const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
      return classes >= 2;
    },
  },
  {
    id: 'jwt',
    title: 'Kod içinde JWT',
    severity: 'medium',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
];

/** Files where example values are expected and should not raise alarms. */
const EXAMPLE_FILE = /(^|\/)(\.env\.(example|sample|template|dist)|.*\.example(\.[a-z]+)?|.*\.sample(\.[a-z]+)?)$/i;
const TEST_FILE = /(^|\/)(__tests__|__mocks__|fixtures?|test|tests|spec)\/|\.(test|spec)\.[a-z]+$/i;

function mask(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-2)}`;
}

/** Scans one file. Returned findings never contain the secret itself (masked preview only). */
export function scanSecrets(filePath: string, content: string): RawFinding[] {
  if (EXAMPLE_FILE.test(filePath)) return [];
  const findings: RawFinding[] = [];
  const isEnvFile = /(^|\/)\.env(\.[a-z]+)?$/i.test(filePath);
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 2000) continue; // minified or data blobs
    for (const rule of RULES) {
      const m = rule.pattern.exec(line);
      if (!m) continue;
      if (rule.validate && !rule.validate(m[0])) continue;
      const inTest = TEST_FILE.test(filePath);
      const severity: Severity = inTest && rule.severity !== 'critical' ? 'low' : rule.severity;
      findings.push({
        type: 'secret',
        severity,
        ruleId: `secret/${rule.id}`,
        title: rule.title,
        description: `${filePath}:${i + 1} satırında ${rule.title.toLowerCase()} bulundu (${mask(m[0])}). Değeri iptal edip yenileyin, secret store'a taşıyın ve git geçmişinden temizleyin.`,
        filePath,
        line: i + 1,
        identity: `${rule.id}|${filePath}|${line.trim()}`,
      });
      break; // one finding per line
    }
  }
  if (isEnvFile && lines.some((l) => /^\s*[A-Z_][A-Z0-9_]*\s*=\s*\S{6,}/.test(l))) {
    findings.push({
      type: 'secret',
      severity: 'high',
      ruleId: 'secret/committed-env-file',
      title: '.env dosyası repository içinde',
      description: `${filePath} gerçek ortam değerleri içeriyor olabilir. Dosyayı repository'den kaldırın, .gitignore'a ekleyin ve değerleri Secret'lar sayfasına taşıyın.`,
      filePath,
      identity: `committed-env|${filePath}`,
    });
  }
  return findings;
}
