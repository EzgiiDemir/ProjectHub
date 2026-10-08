import type { Severity } from '@projecthub/contracts';
import type { RawFinding } from './types.js';

interface CodeRule {
  id: string;
  title: string;
  severity: Severity;
  files: RegExp;
  pattern: RegExp;
  advice: string;
}

/** Deliberately small, high-signal SAST rule set. Each rule targets a concrete exploitable pattern. */
const RULES: CodeRule[] = [
  {
    id: 'js-eval',
    title: 'eval / new Function kullanımı',
    severity: 'medium',
    files: /\.[cm]?[jt]sx?$/,
    pattern: /(^|[^.\w])(eval\s*\(|new\s+Function\s*\()/,
    advice: 'Dinamik kod çalıştırmak enjeksiyon riskidir. Veriyi JSON.parse veya açık bir eşleme ile işleyin.',
  },
  {
    id: 'js-command-injection',
    title: 'Komut satırına değişken enjeksiyonu',
    severity: 'high',
    files: /\.[cm]?[jt]sx?$/,
    pattern: /\b(exec|execSync)\s*\(\s*(`[^`]*\$\{|[^)]*\+\s*(req|request|params|query|body|input|args))/,
    advice: 'Kullanıcı girdisi shell komutuna ekleniyor. execFile/spawn ile argüman dizisi kullanın.',
  },
  {
    id: 'js-sql-injection',
    title: 'SQL sorgusunda string birleştirme',
    severity: 'high',
    files: /\.[cm]?[jt]sx?$/,
    pattern: /\.(query|execute|raw|\$queryRawUnsafe|\$executeRawUnsafe)\s*\(\s*(`[^`]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{|["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"']*["']\s*\+)/i,
    advice: 'Sorguya değer string olarak ekleniyor. Parametreli sorgu ($1, ?) veya ORM sorgu oluşturucusu kullanın.',
  },
  {
    id: 'js-dangerous-html',
    title: 'Ham HTML enjeksiyonu',
    severity: 'medium',
    files: /\.[cm]?[jt]sx?$|\.vue$|\.svelte$/,
    pattern: /dangerouslySetInnerHTML|\.innerHTML\s*=(?!=)|v-html=|\{@html\s/,
    advice: 'Güvenilmeyen içerik XSS oluşturabilir. İçeriği sanitize edin (ör. DOMPurify) veya metin olarak basın.',
  },
  {
    id: 'tls-verification-disabled',
    title: 'TLS sertifika doğrulaması kapatılmış',
    severity: 'medium',
    files: /\.[cm]?[jt]sx?$|\.py$|\.go$|\.env$|\.ya?ml$/,
    pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true/,
    advice: 'Ortadaki adam saldırılarına açık. Sertifika doğrulamasını açın; gerekiyorsa özel CA ekleyin.',
  },
  {
    id: 'weak-hash-password',
    title: 'Şifre için zayıf hash (MD5/SHA1)',
    severity: 'high',
    files: /\.[cm]?[jt]sx?$|\.py$|\.php$/,
    pattern: /(md5|sha1)\s*\(\s*[^)]*pass(word)?|createHash\(\s*['"](md5|sha1)['"]\s*\)[^;\n]*pass(word)?/i,
    advice: 'Şifreler argon2id, bcrypt veya scrypt ile saklanmalı.',
  },
  {
    id: 'php-sql-injection',
    title: 'PHP sorgusunda istek verisi',
    severity: 'high',
    files: /\.php$/,
    pattern: /(mysqli_query|->query|mysql_query)\s*\([^;]*\$_(GET|POST|REQUEST|COOKIE)/,
    advice: 'İstek verisi doğrudan sorguya giriyor. PDO prepared statement kullanın.',
  },
  {
    id: 'php-eval-input',
    title: 'PHP eval/exec ile istek verisi',
    severity: 'critical',
    files: /\.php$/,
    pattern: /\b(eval|system|exec|shell_exec|passthru)\s*\([^;]*\$_(GET|POST|REQUEST|COOKIE)/,
    advice: 'Uzaktan kod çalıştırma riski. İstek verisini asla çalıştırmayın.',
  },
  {
    id: 'py-shell-true',
    title: 'subprocess shell=True',
    severity: 'medium',
    files: /\.py$/,
    pattern: /subprocess\.(run|call|Popen|check_output)\([^)]*shell\s*=\s*True/,
    advice: 'Argüman listesi ile shell=False kullanın.',
  },
  {
    id: 'py-unsafe-deserialize',
    title: 'Güvensiz deserialization',
    severity: 'high',
    files: /\.py$/,
    pattern: /pickle\.loads?\(|yaml\.load\((?![^)]*Loader\s*=\s*yaml\.SafeLoader)/,
    advice: 'Güvenilmeyen veride yaml.safe_load / JSON kullanın.',
  },
  {
    id: 'cors-wildcard-credentials',
    title: 'CORS: her kaynağa kimlik bilgisiyle izin',
    severity: 'medium',
    files: /\.[cm]?[jt]sx?$|\.py$|\.php$/,
    pattern: /origin\s*:\s*(['"]\*['"]|true)[^}\n]*credentials\s*:\s*true|credentials\s*:\s*true[^}\n]*origin\s*:\s*(['"]\*['"]|true)/,
    advice: 'Kimlik bilgisi gönderilen isteklerde izinli origin listesini açıkça belirtin.',
  },
];

const TEST_FILE = /(^|\/)(__tests__|__mocks__|fixtures?|tests?|spec)\/|\.(test|spec)\.[a-z]+$/i;

export function scanCode(filePath: string, content: string): RawFinding[] {
  if (TEST_FILE.test(filePath)) return [];
  const findings: RawFinding[] = [];
  const rules = RULES.filter((r) => r.files.test(filePath));
  if (!rules.length) return findings;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 1500) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;
    for (const rule of rules) {
      if (!rule.pattern.test(line)) continue;
      findings.push({
        type: 'code',
        severity: rule.severity,
        ruleId: `code/${rule.id}`,
        title: rule.title,
        description: `${filePath}:${i + 1} — ${rule.advice}`,
        filePath,
        line: i + 1,
        identity: `${rule.id}|${filePath}|${trimmed}`,
      });
    }
  }
  return findings;
}
