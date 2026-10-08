import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { PERMISSIONS, SYSTEM_ROLES, ALL_PERMISSIONS } from '@projecthub/contracts';
import type { Database } from './client.js';
import { deviceProfiles, permissions, rolePermissions, roles } from './schema/index.js';

/** Viewport profiles for the simulator and automated responsive tests (spec: 15–20 profiles). */
export const DEVICE_PROFILES = [
  { key: 'phone-small', name: 'Küçük telefon', category: 'phone', width: 360, height: 640, scaleFactor: 2, isMobile: true },
  { key: 'iphone-se', name: 'iPhone SE', category: 'phone', width: 375, height: 667, scaleFactor: 2, isMobile: true },
  { key: 'iphone-15', name: 'iPhone 15', category: 'phone', width: 393, height: 852, scaleFactor: 3, isMobile: true, isDefault: true },
  { key: 'iphone-15-pro-max', name: 'iPhone 15 Pro Max', category: 'phone', width: 430, height: 932, scaleFactor: 3, isMobile: true },
  { key: 'pixel-8', name: 'Google Pixel 8', category: 'phone', width: 412, height: 915, scaleFactor: 2.625, isMobile: true },
  { key: 'galaxy-s24', name: 'Samsung Galaxy S24', category: 'phone', width: 384, height: 832, scaleFactor: 3, isMobile: true },
  { key: 'galaxy-a54', name: 'Samsung Galaxy A54', category: 'phone', width: 412, height: 892, scaleFactor: 2.625, isMobile: true },
  { key: 'galaxy-fold-open', name: 'Galaxy Z Fold (açık)', category: 'tablet', width: 673, height: 841, scaleFactor: 2.5, isMobile: true },
  { key: 'ipad-mini', name: 'iPad mini', category: 'tablet', width: 744, height: 1133, scaleFactor: 2, isMobile: true },
  { key: 'ipad-10', name: 'iPad 10. nesil', category: 'tablet', width: 820, height: 1180, scaleFactor: 2, isMobile: true },
  { key: 'ipad-pro-13', name: 'iPad Pro 13"', category: 'tablet', width: 1024, height: 1366, scaleFactor: 2, isMobile: true },
  { key: 'android-tablet', name: 'Android tablet', category: 'tablet', width: 800, height: 1280, scaleFactor: 2, isMobile: true },
  { key: 'laptop-1280', name: 'Laptop 1280', category: 'desktop', width: 1280, height: 800, scaleFactor: 1, isMobile: false },
  { key: 'laptop-1366', name: 'Laptop 1366', category: 'desktop', width: 1366, height: 768, scaleFactor: 1, isMobile: false },
  { key: 'macbook-air', name: 'MacBook Air 13"', category: 'desktop', width: 1440, height: 900, scaleFactor: 2, isMobile: false },
  { key: 'desktop-1920', name: 'Masaüstü Full HD', category: 'desktop', width: 1920, height: 1080, scaleFactor: 1, isMobile: false },
  { key: 'desktop-2560', name: 'Masaüstü 2K', category: 'desktop', width: 2560, height: 1440, scaleFactor: 1, isMobile: false },
  { key: 'ultrawide-3440', name: 'Ultra geniş 3440', category: 'desktop', width: 3440, height: 1440, scaleFactor: 1, isMobile: false },
] as const;

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

/**
 * Reference data required for the system to function. Idempotent: safe to run on every deploy.
 * Not demo data — it contains no projects, users or customer records.
 */
export async function seedReferenceData(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. Permission catalog (code is the source of truth).
    for (const key of ALL_PERMISSIONS) {
      const p = PERMISSIONS[key];
      await tx
        .insert(permissions)
        .values({ key, groupName: p.group, description: p.label })
        .onConflictDoUpdate({ target: permissions.key, set: { groupName: p.group, description: p.label } });
    }
    await tx.delete(permissions).where(notInArray(permissions.key, ALL_PERMISSIONS));

    // 2. Built-in system roles and their exact permission sets.
    for (const def of SYSTEM_ROLES) {
      const existing = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(isNull(roles.organizationId), eq(roles.key, def.key)));
      let roleId = existing[0]?.id;
      if (roleId) {
        await tx.update(roles).set({ name: def.name, description: def.description, isSystem: true }).where(eq(roles.id, roleId));
      } else {
        const inserted = await tx
          .insert(roles)
          .values({ key: def.key, name: def.name, description: def.description, isSystem: true })
          .returning({ id: roles.id });
        roleId = inserted[0]!.id;
      }
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
      await tx.insert(rolePermissions).values(def.permissions.map((permissionKey) => ({ roleId: roleId!, permissionKey })));
    }

    // 3. Device profiles.
    for (const [i, d] of DEVICE_PROFILES.entries()) {
      const ua = !d.isMobile ? null : d.key.startsWith('iphone') || d.key.startsWith('ipad') ? MOBILE_UA : ANDROID_UA;
      const values = {
        key: d.key,
        name: d.name,
        category: d.category,
        width: d.width,
        height: d.height,
        scaleFactor: d.scaleFactor,
        isMobile: d.isMobile,
        userAgent: ua,
        isDefault: 'isDefault' in d ? d.isDefault : false,
        sort: i,
      };
      await tx.insert(deviceProfiles).values(values).onConflictDoUpdate({ target: deviceProfiles.key, set: values });
    }
  });
}

export async function getSystemRoleIds(db: Database, keys: string[]): Promise<Record<string, string>> {
  const rows = await db
    .select({ id: roles.id, key: roles.key })
    .from(roles)
    .where(and(isNull(roles.organizationId), inArray(roles.key, keys)));
  return Object.fromEntries(rows.map((r) => [r.key, r.id]));
}
