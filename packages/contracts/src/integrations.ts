import { z } from 'zod';

/**
 * Third-party integrations a managed project can use. Every field becomes an environment variable of the project's
 * builds and deployments (secret fields are stored encrypted and never shown again).
 */
export interface IntegrationField {
  key: string;
  label: string;
  /** Environment variable name; `{PREFIX}` is replaced for providers that allow several instances. */
  env: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface IntegrationProviderInfo {
  id: string;
  name: string;
  description: string;
  /** Several instances per project, told apart by an environment variable prefix. */
  prefixed?: boolean;
  docsUrl: string;
  fields: IntegrationField[];
}

export const INTEGRATION_CATALOG: IntegrationProviderInfo[] = [
  {
    id: 'microsoft-entra',
    name: 'Microsoft Entra ID',
    description: 'Kurumsal hesaplarla giriş (Azure AD / Office 365 tek oturum açma).',
    docsUrl: 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app',
    fields: [
      { key: 'tenantId', label: 'Kiracı (Tenant) ID', env: 'AZURE_AD_TENANT_ID', required: true, placeholder: '00000000-0000-0000-0000-000000000000', help: 'Entra yönetim merkezi → Genel bakış → Kiracı kimliği' },
      { key: 'clientId', label: 'Uygulama (Client) ID', env: 'AZURE_AD_CLIENT_ID', required: true, help: 'Uygulama kayıtları → uygulamanız → Uygulama (istemci) kimliği' },
      { key: 'clientSecret', label: 'Client secret', env: 'AZURE_AD_CLIENT_SECRET', secret: true, required: true, help: 'Sertifikalar ve gizli diziler → Yeni istemci gizli dizisi (değeri, kimliği değil)' },
      { key: 'redirectUri', label: 'Yönlendirme adresi', env: 'AZURE_AD_REDIRECT_URI', placeholder: 'https://uygulama.sirket.com/auth/callback', help: 'Uygulama kaydındaki “Yeniden yönlendirme URI” ile aynı olmalı' },
    ],
  },
  {
    id: 'wordpress',
    name: 'WordPress / WP Forms',
    description: 'WordPress sitesinden içerik ve WP Forms form kayıtları (REST API ve uygulama şifresi).',
    docsUrl: 'https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/',
    fields: [
      { key: 'siteUrl', label: 'Site adresi', env: 'WORDPRESS_URL', required: true, placeholder: 'https://www.sirket.com' },
      { key: 'username', label: 'Kullanıcı adı', env: 'WORDPRESS_USERNAME', required: true },
      { key: 'appPassword', label: 'Uygulama şifresi', env: 'WORDPRESS_APP_PASSWORD', secret: true, required: true, help: 'WordPress → Kullanıcılar → Profil → Uygulama şifreleri (giriş şifresi değil)' },
      { key: 'formId', label: 'WP Forms form ID', env: 'WPFORMS_FORM_ID', placeholder: '123', help: 'İsteğe bağlı: projenin kullandığı formun numarası' },
    ],
  },
  {
    id: 'google-analytics',
    name: 'Google Analytics 4',
    description: 'Ziyaretçi istatistikleri için ölçüm kimliği.',
    docsUrl: 'https://support.google.com/analytics/answer/9539598',
    fields: [{ key: 'measurementId', label: 'Ölçüm kimliği', env: 'GA_MEASUREMENT_ID', required: true, placeholder: 'G-XXXXXXXXXX' }],
  },
  {
    id: 'smtp',
    name: 'E-posta (SMTP)',
    description: 'Uygulamanın e-posta göndermesi (Office 365, Gmail, kurumsal posta sunucusu).',
    docsUrl: 'https://learn.microsoft.com/exchange/mail-flow-best-practices/how-to-set-up-a-multifunction-device-or-application-to-send-email-using-microsoft-365-or-office-365',
    fields: [
      { key: 'host', label: 'Sunucu', env: 'SMTP_HOST', required: true, placeholder: 'smtp.office365.com' },
      { key: 'port', label: 'Port', env: 'SMTP_PORT', required: true, placeholder: '587' },
      { key: 'user', label: 'Kullanıcı', env: 'SMTP_USER' },
      { key: 'password', label: 'Şifre', env: 'SMTP_PASSWORD', secret: true },
      { key: 'from', label: 'Gönderen', env: 'SMTP_FROM', placeholder: 'Proje <noreply@sirket.com>' },
    ],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Uygulamanın Slack kanalına mesaj göndermesi (gelen webhook).',
    docsUrl: 'https://api.slack.com/messaging/webhooks',
    fields: [{ key: 'webhookUrl', label: 'Webhook adresi', env: 'SLACK_WEBHOOK_URL', secret: true, required: true, placeholder: 'https://hooks.slack.com/services/…' }],
  },
  {
    id: 'webhook',
    name: 'Webhook',
    description: 'Başka bir sisteme olay bildirimi göndermek için adres ve imzalama anahtarı.',
    prefixed: true,
    docsUrl: 'https://en.wikipedia.org/wiki/Webhook',
    fields: [
      { key: 'url', label: 'Adres', env: '{PREFIX}_WEBHOOK_URL', required: true, placeholder: 'https://sistem.sirket.com/hooks/proje' },
      { key: 'secret', label: 'İmzalama anahtarı', env: '{PREFIX}_WEBHOOK_SECRET', secret: true },
    ],
  },
  {
    id: 'rest-api',
    name: 'REST API',
    description: 'Projenin kullandığı başka bir servis (ERP, kargo, ödeme, CRM …).',
    prefixed: true,
    docsUrl: 'https://developer.mozilla.org/docs/Web/HTTP/Authentication',
    fields: [
      { key: 'baseUrl', label: 'Temel adres', env: '{PREFIX}_BASE_URL', required: true, placeholder: 'https://api.ornek.com/v1' },
      { key: 'apiKey', label: 'API anahtarı', env: '{PREFIX}_API_KEY', secret: true },
      { key: 'authHeader', label: 'Kimlik başlığı', env: '{PREFIX}_AUTH_HEADER', placeholder: 'Authorization', help: 'Boşsa “Authorization: Bearer <anahtar>” kullanılır' },
    ],
  },
];

export const integrationInputSchema = z.object({
  provider: z.string().min(1).max(40),
  name: z.string().trim().min(2).max(120),
  prefix: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,30}$/, 'Önek büyük harf, rakam ve _ içermeli (ör. KARGO)')
    .optional(),
  /** Field values by key; an empty secret on update keeps the stored value. */
  values: z.record(z.string(), z.string().max(4000)),
  enabled: z.boolean().default(true),
});
export type IntegrationInput = z.infer<typeof integrationInputSchema>;

export function integrationProvider(id: string): IntegrationProviderInfo | undefined {
  return INTEGRATION_CATALOG.find((p) => p.id === id);
}

export function integrationEnvName(field: IntegrationField, prefix?: string | null): string {
  return field.env.replace('{PREFIX}', prefix ?? 'SERVIS');
}
