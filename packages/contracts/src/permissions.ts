/**
 * Permission catalog. This file is the single, version-controlled source of truth:
 * the database seed, backend guards and frontend UI gating all read from it.
 */
export const PERMISSIONS = {
  'project.read': { group: 'Proje', label: 'Projeyi görüntüleme' },
  'project.read.all': { group: 'Proje', label: 'Üye olmadığı projeleri de görme' },
  'project.create': { group: 'Proje', label: 'Proje oluşturma / içe aktarma' },
  'project.update': { group: 'Proje', label: 'Proje ayarlarını değiştirme' },
  'project.archive': { group: 'Proje', label: 'Projeyi arşivleme / geri alma' },
  'project.members.manage': { group: 'Proje', label: 'Proje üyelerini yönetme' },
  'repository.read': { group: 'Kaynak kod', label: 'Kaynak kodu görme' },
  'repository.push': { group: 'Kaynak kod', label: 'Dosya değiştirme / commit / branch' },
  'build.create': { group: 'Build', label: 'Build başlatma' },
  'preview.create': { group: 'Ön izleme', label: 'Ön izleme ve cihaz testi oluşturma' },
  'preview.delete': { group: 'Ön izleme', label: 'Ön izlemeyi durdurma' },
  'review.create': { group: 'Müşteri', label: 'Müşteri linki oluşturma / kapatma' },
  'feedback.manage': { group: 'Müşteri', label: 'Feedback ve görev yönetimi' },
  'version.create': { group: 'Yayın', label: 'Versiyon oluşturma' },
  'environment.manage': { group: 'Yayın', label: 'Ortam ve deployment hedefi yönetimi' },
  'deployment.staging': { group: 'Yayın', label: 'Staging / development deployment' },
  'deployment.production': { group: 'Yayın', label: 'Production deployment' },
  'deployment.approve': { group: 'Yayın', label: 'Deployment onaylama' },
  'database.manage': { group: 'Yayın', label: 'Veritabanı bağlantısı ve yedek yönetimi' },
  'secret.manage': { group: 'Güvenlik', label: 'Secret oluşturma / değiştirme' },
  'secret.read': { group: 'Güvenlik', label: 'Secret değerini görüntüleme' },
  'security.read': { group: 'Güvenlik', label: 'Güvenlik bulgularını görme' },
  'security.manage': { group: 'Güvenlik', label: 'Tarama ve bulgu yönetimi' },
  'ai.execute': { group: 'AI', label: 'AI görevi çalıştırma' },
  'ai.approve': { group: 'AI', label: 'AI değişikliğini onaylama / birleştirme' },
  'admin.users.manage': { group: 'Yönetim', label: 'Kullanıcı yönetimi' },
  'admin.roles.manage': { group: 'Yönetim', label: 'Rol ve yetki yönetimi' },
  'admin.settings.manage': { group: 'Yönetim', label: 'Sistem, AI ve entegrasyon ayarları' },
  'admin.audit.read': { group: 'Yönetim', label: 'Denetim kaydını görme' },
  'admin.system.read': { group: 'Yönetim', label: 'Altyapı ve sistem sağlığını görme' },
} as const satisfies Record<string, { group: string; label: string }>;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** Permissions that only make sense organization-wide (never granted through a project role). */
export const ORG_ONLY_PERMISSIONS: Permission[] = [
  'project.read.all',
  'project.create',
  'admin.users.manage',
  'admin.roles.manage',
  'admin.settings.manage',
  'admin.audit.read',
  'admin.system.read',
];

export interface SystemRoleDefinition {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
}

const developerBase: Permission[] = [
  'project.read',
  'repository.read',
  'repository.push',
  'build.create',
  'preview.create',
  'preview.delete',
  'deployment.staging',
  'security.read',
  'ai.execute',
];

export const SYSTEM_ROLES: SystemRoleDefinition[] = [
  {
    key: 'super_admin',
    name: 'Sistem Yöneticisi',
    description: 'Tüm sistem ve tüm projeler üzerinde tam yetki.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'project_manager',
    name: 'Proje Yöneticisi',
    description: 'Projeleri, müşteri süreçlerini ve yayınları yönetir.',
    permissions: [
      'project.read',
      'project.create',
      'project.update',
      'project.archive',
      'project.members.manage',
      'repository.read',
      'repository.push',
      'build.create',
      'preview.create',
      'preview.delete',
      'review.create',
      'feedback.manage',
      'version.create',
      'environment.manage',
      'deployment.staging',
      'deployment.production',
      'deployment.approve',
      'database.manage',
      'secret.manage',
      'security.read',
      'security.manage',
      'ai.execute',
      'ai.approve',
      'admin.audit.read',
    ],
  },
  {
    key: 'lead_developer',
    name: 'Lead Developer',
    description: 'Kod, yayın ve AI değişikliklerini onaylayabilen kıdemli geliştirici.',
    permissions: [
      ...developerBase,
      'project.update',
      'project.members.manage',
      'review.create',
      'feedback.manage',
      'version.create',
      'environment.manage',
      'deployment.production',
      'deployment.approve',
      'database.manage',
      'secret.manage',
      'secret.read',
      'security.manage',
      'ai.approve',
    ],
  },
  {
    key: 'developer',
    name: 'Developer',
    description: 'Kod yazar, build ve staging deployment yapar.',
    permissions: [...developerBase, 'feedback.manage'],
  },
  {
    key: 'designer',
    name: 'Designer',
    description: 'Ön izlemeleri inceler, müşteri linki paylaşır.',
    permissions: ['project.read', 'repository.read', 'preview.create', 'review.create', 'feedback.manage'],
  },
  {
    key: 'qa',
    name: 'Tester',
    description: 'Ön izleme ve cihaz testlerini yürütür, feedback yönetir.',
    permissions: ['project.read', 'repository.read', 'build.create', 'preview.create', 'feedback.manage', 'security.read'],
  },
  {
    key: 'viewer',
    name: 'Görüntüleyici',
    description: 'Yalnızca üyesi olduğu projeleri görüntüler.',
    permissions: ['project.read'],
  },
];
