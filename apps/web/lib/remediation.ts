import type { Finding } from './types';

/** What the person looking at a security finding needs: the problem, the steps that fix it and the actions. */
export interface Remediation {
  problem: string;
  where: string | null;
  steps: string[];
  command: { label: string; text: string } | null;
  links: { label: string; href: string; external?: boolean }[];
}

/** Where to revoke a leaked credential, by secret rule. */
const REVOKE: Record<string, [string, string]> = {
  'aws-access-key': ['AWS IAM erişim anahtarları', 'https://console.aws.amazon.com/iam/home#/security_credentials'],
  'aws-secret-key': ['AWS IAM erişim anahtarları', 'https://console.aws.amazon.com/iam/home#/security_credentials'],
  'github-token': ['GitHub tokenları', 'https://github.com/settings/tokens'],
  'gitlab-token': ['GitLab erişim tokenları', 'https://gitlab.com/-/user_settings/personal_access_tokens'],
  'stripe-live-key': ['Stripe API anahtarları', 'https://dashboard.stripe.com/apikeys'],
  'openai-key': ['OpenAI API anahtarları', 'https://platform.openai.com/api-keys'],
  'anthropic-key': ['Anthropic API anahtarları', 'https://console.anthropic.com/settings/keys'],
  'google-api-key': ['Google Cloud kimlik bilgileri', 'https://console.cloud.google.com/apis/credentials'],
  'slack-token': ['Slack uygulamaları', 'https://api.slack.com/apps'],
  'slack-webhook': ['Slack uygulamaları', 'https://api.slack.com/apps'],
  'sendgrid-key': ['SendGrid API anahtarları', 'https://app.sendgrid.com/settings/api_keys'],
  'twilio-key': ['Twilio konsolu', 'https://console.twilio.com'],
  'npm-token': ['npm erişim tokenları', 'https://www.npmjs.com/settings/~/tokens'],
};

/** Fix guidance for code and configuration rules. */
const RULE_STEPS: Record<string, string[]> = {
  'code/js-eval': ['eval / new Function yerine JSON.parse veya açık bir eşleme (switch/obje) kullanın.', 'Kullanıcıdan gelen veriyi asla kod olarak çalıştırmayın.'],
  'code/js-command-injection': ['exec yerine argümanları dizi olarak alan execFile/spawn kullanın.', 'Kullanıcı girdisini komut satırına eklemeyin; izin verilen değerler listesiyle doğrulayın.'],
  'code/js-sql-injection': ['SQL’i metin birleştirerek kurmayın; parametreli sorgu ($1, ?) veya ORM sorgu oluşturucusu kullanın.'],
  'code/js-dangerous-html': ['dangerouslySetInnerHTML / innerHTML yerine metni normal JSX ile gösterin.', 'HTML gerçekten gerekiyorsa DOMPurify ile temizleyin.'],
  'code/tls-verification-disabled': ['rejectUnauthorized: false / verify=False ayarını kaldırın.', 'Kendi sertifikanız varsa CA dosyasını güvenilenlere ekleyin.'],
  'code/hardcoded-credential': ['Parolayı koddan çıkarın, ortam değişkeni olarak okuyun.', 'Değeri Project Hub Secret’larına ekleyin; build ve deployment ortama otomatik verir.'],
  'code/weak-hash-password': ['Parolaları MD5/SHA1 ile değil argon2id veya bcrypt ile saklayın.', 'Mevcut kullanıcılar bir sonraki girişte yeni algoritmaya taşınabilir.'],
  'code/php-sql-injection': ['mysqli_query / $wpdb->query içinde değişken birleştirmeyin; prepared statement ($wpdb->prepare, PDO) kullanın.'],
  'code/php-eval-input': ['eval / assert ile istek verisini çalıştırmayı kaldırın.'],
  'code/py-shell-true': ['subprocess çağrılarında shell=True kullanmayın; komutu liste olarak verin.'],
  'code/py-unsafe-deserialize': ['pickle / yaml.load yerine json veya yaml.safe_load kullanın.'],
  'code/cors-wildcard-credentials': ['Access-Control-Allow-Origin: * ile credentials birlikte kullanılamaz; izin verilen alan adlarını tek tek yazın.'],
  'code/jwt': ['Token’ı koddan çıkarın ve iptal edin; imzalama anahtarını yenileyin.'],
  'config/docker-unpinned-image': ['Dockerfile’daki imajı sabit bir sürüme bağlayın (ör. node:24.2-alpine, “latest” yerine).'],
  'config/docker-root-user': ['Dockerfile sonuna root olmayan bir kullanıcı ekleyin: USER node (veya RUN adduser … && USER app).'],
  'config/docker-secret-in-image': ['Secret’ı imaja kopyalamayın (ENV/ARG/COPY); çalışma zamanında ortam değişkeni olarak verin.'],
  'config/missing-lockfile': ['Lock dosyasını oluşturup repoya ekleyin (npm install → package-lock.json, pnpm install → pnpm-lock.yaml).', 'Böylece her build aynı paket sürümleriyle çalışır ve zafiyet taraması kesinleşir.'],
  'config/env-not-ignored': ['.gitignore dosyasına “.env” satırını ekleyin.', 'Repoya eklenmiş .env dosyası varsa silin ve içindeki anahtarları yenileyin.'],
  'iac/compose-privileged': ['Servisten “privileged: true” satırını kaldırın.', 'Gerçekten gereken yetki varsa yalnızca onu “cap_add” ile ekleyin.'],
  'iac/compose-docker-socket': ['docker.sock bağlamasını kaldırın.', 'Zorunluysa (ör. reverse proxy) “:ro” ile salt okunur bağlayın ve servisi güvenilir altyapı imajlarıyla sınırlayın.'],
  'iac/compose-host-network': ['“network_mode: host” yerine bir Compose ağı kullanın ve gereken portu “ports” ile yayınlayın.'],
  'iac/compose-host-namespace': ['“pid: host” / “ipc: host” satırlarını kaldırın.'],
  'iac/compose-dangerous-capability': ['“cap_add” listesinden SYS_ADMIN/ALL gibi geniş yetkileri çıkarın; gerekiyorsa dar bir yetki seçin.'],
  'iac/compose-unconfined': ['“security_opt” içindeki unconfined ayarını kaldırın; varsayılan seccomp/apparmor profili kalsın.'],
  'iac/compose-exposed-datastore': ['Veritabanı portunu dışarı açmayın: “ports” satırını silin (servisler ağ içinden erişir)', 'Yerelden erişim gerekiyorsa “127.0.0.1:PORT:PORT” biçiminde bağlayın.'],
  'iac/compose-inline-secret': ['Değeri dosyadan silin, “.env” dosyasına taşıyın ve Compose’da ${DEGISKEN} ile okuyun.', 'Dosya repoya girdiği için anahtarı/parolayı yenileyin.'],
  'iac/k8s-privileged': ['Container securityContext’inden “privileged: true” satırını kaldırın.'],
  'iac/k8s-privilege-escalation': ['securityContext’e “allowPrivilegeEscalation: false” ekleyin.'],
  'iac/k8s-root-user': ['securityContext’e “runAsNonRoot: true” ve “runAsUser: 1000” (root olmayan bir kullanıcı) ekleyin.'],
  'iac/k8s-host-namespace': ['Pod spec’inden hostNetwork/hostPID/hostIPC satırlarını kaldırın.'],
  'iac/k8s-host-path': ['hostPath yerine PersistentVolumeClaim, ConfigMap veya emptyDir kullanın.'],
  'iac/k8s-unpinned-image': ['İmajı sabit bir sürüme (veya @sha256 özetine) bağlayın.'],
  'iac/k8s-no-limits': ['Container’a “resources.limits” (cpu, memory) ve “requests” ekleyin.'],
  'iac/tf-open-admin-port': ['cidr_blocks değerini ofis/VPN IP aralığınızla değiştirin; SSH/RDP/veritabanı portlarını internete açmayın.'],
  'iac/tf-open-ingress': ['Kaynağı gerçekten herkese açık olması gerekmiyorsa cidr_blocks’u daraltın (ör. yük dengeleyici güvenlik grubu).'],
  'iac/tf-public-bucket': ['acl satırını kaldırın ve aws_s3_bucket_public_access_block ile herkese açık erişimi engelleyin.'],
  'iac/tf-public-database': ['publicly_accessible = false yapın; erişimi özel ağ veya VPN üzerinden verin.'],
  'iac/tf-unencrypted-storage': ['encrypted / storage_encrypted = true ayarlayın.'],
  'iac/tf-inline-secret': ['Değeri dosyadan silip “sensitive = true” bir değişkenden veya secret yöneticisinden okuyun.', 'Değer repoya girdiği için parolayı/anahtarı yenileyin.'],
  'secret/committed-env-file': ['.env dosyasını repodan silin ve .gitignore’a ekleyin.', 'İçindeki tüm anahtarları yenileyin; değerleri Project Hub Secret’larına taşıyın.'],
};

function upgradeCommand(f: Finding): { label: string; text: string } | null {
  if (!f.packageName || !f.fixedVersion) return null;
  const src = f.filePath ?? '';
  const v = f.fixedVersion;
  if (src.endsWith('pnpm-lock.yaml')) return { label: 'pnpm', text: `pnpm update ${f.packageName}@^${v}` };
  if (src.endsWith('yarn.lock')) return { label: 'yarn', text: `yarn up ${f.packageName}@^${v}` };
  if (src.endsWith('requirements.txt')) return { label: 'requirements.txt', text: `${f.packageName}==${v}` };
  if (src.endsWith('go.mod')) return { label: 'go', text: `go get ${f.packageName}@v${v.replace(/^v/, '')}` };
  if (src.endsWith('Cargo.lock')) return { label: 'cargo', text: `cargo update -p ${f.packageName} --precise ${v}` };
  if (src.endsWith('composer.lock')) return { label: 'composer', text: `composer require ${f.packageName}:^${v}` };
  return { label: 'npm', text: `npm install ${f.packageName}@^${v}` };
}

export function remediationFor(f: Finding, slug: string): Remediation {
  const file = f.filePath ? `${f.filePath}${f.line ? `:${f.line}` : ''}` : null;
  const openFile = f.filePath ? [{ label: 'Dosyayı düzenleyicide aç', href: `/projects/${slug}/code?path=${encodeURIComponent(f.filePath)}${f.line ? `&line=${f.line}` : ''}` }] : [];
  const host = (href: string) => {
    try {
      return new URL(href).hostname.replace(/^www\./, '');
    } catch {
      return 'Kaynak';
    }
  };
  const refs = f.references.slice(0, 3).map((href) => ({ label: host(href), href, external: true }));

  if (f.type === 'dependency') {
    const outdated = f.ruleId === 'dependency/outdated-major';
    const advisory = f.advisoryId ? [{ label: `${f.advisoryId} ayrıntısı`, href: `https://osv.dev/vulnerability/${encodeURIComponent(f.advisoryId)}`, external: true }] : [];
    return {
      problem: outdated
        ? `${f.packageName} paketi çok eski (${f.packageVersion} kullanılıyor, güncel sürüm ${f.fixedVersion}).`
        : `${f.packageName} ${f.packageVersion} sürümünde bilinen bir güvenlik açığı var: ${f.title.replace(/^.*? — /, '')}`,
      where: file,
      steps: f.fixedVersion
        ? [`${f.packageName} paketini ${f.fixedVersion} veya daha yeni bir sürüme yükseltin.`, 'Lock dosyasını da güncelleyip commit edin.', 'Build ve testler geçtikten sonra “Çözüldü” deyin; tarama yeni sürümü doğrular.']
        : ['Bu açık için henüz düzeltilmiş sürüm yayımlanmamış.', 'Paketi kaldırmayı veya alternatifini kullanmayı değerlendirin; mümkün değilse gerekçesiyle “Riski kabul et”.'],
      command: upgradeCommand(f),
      links: [{ label: 'Bağımlılık merkezinde aç', href: `/projects/${slug}/dependencies` }, ...advisory, ...refs],
    };
  }

  if (f.type === 'secret') {
    const rule = f.ruleId.replace(/^secret\//, '');
    const revoke = REVOKE[rule];
    return {
      problem: `${f.title} kaynak kodda açık olarak duruyor. Repoya erişen herkes bu değeri kullanabilir.`,
      where: file,
      steps: RULE_STEPS[f.ruleId] ?? [
        `Önce anahtarı iptal edip yenisini oluşturun${revoke ? ` (${revoke[0]})` : ''} — kodu düzeltmek tek başına yetmez, değer Git geçmişinde kalır.`,
        'Yeni değeri koda yazmayın; Project Hub Secret’larına ekleyin, uygulama onu ortam değişkeni olarak okur.',
        'Koddaki değeri kaldırıp commit edin, ardından “Çözüldü” deyin.',
      ],
      command: null,
      links: [...(revoke ? [{ label: `${revoke[0]} — iptal et`, href: revoke[1], external: true }] : []), { label: 'Secret ekle', href: `/projects/${slug}/secrets` }, ...openFile],
    };
  }

  return {
    problem: f.description || f.title,
    where: file,
    steps: RULE_STEPS[f.ruleId] ?? ['Dosyadaki ilgili satırı açıp sorunu giderin.', 'Değişikliği commit edin ve “Çözüldü” deyin; tarama sorunun kalmadığını doğrular.'],
    command: null,
    links: [...openFile, ...refs],
  };
}
