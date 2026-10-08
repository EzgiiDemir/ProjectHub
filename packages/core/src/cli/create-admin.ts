#!/usr/bin/env node
import { parseArgs } from 'node:util';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import { passwordSchema } from '@projecthub/contracts';
import {
  auditEvents,
  createDatabase,
  getSystemRoleIds,
  migrateDatabase,
  organizationMemberRoles,
  organizationMembers,
  organizations,
  users,
} from '@projecthub/database';
import { hashPassword } from '../crypto.js';
import { loadConfig } from '../config.js';
import { slugify } from '../manifest.js';

/**
 * Bootstraps the first organization and its Super Admin (spec §131: "İlk Super Admin CLI üzerinden oluşturulmalıdır").
 * Usage: pnpm admin:create --email admin@company.com --name "Ad Soyad" --org "Şirket Adı"
 * The password is read from PH_ADMIN_PASSWORD or prompted (hidden) on the terminal.
 */
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    org: { type: 'string' },
    'org-slug': { type: 'string' },
  },
});

async function promptHidden(question: string): Promise<string> {
  let muted = false;
  const out = new Writable({
    write(chunk, enc, cb) {
      if (!muted) process.stdout.write(chunk, enc);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

const email = values.email?.trim().toLowerCase();
const name = values.name?.trim();
const orgName = values.org?.trim();
if (!email || !name || !orgName) {
  console.error('Usage: pnpm admin:create --email <email> --name "<full name>" --org "<organization name>" [--org-slug <slug>]');
  process.exit(1);
}

const config = loadConfig();
let password = process.env.PH_ADMIN_PASSWORD ?? '';
if (!password) {
  password = await promptHidden('Password (min 12 chars, letters + digits): ');
  const again = await promptHidden('Repeat password: ');
  if (again !== password) {
    console.error('Passwords do not match.');
    process.exit(1);
  }
}
const pw = passwordSchema.safeParse(password);
if (!pw.success) {
  console.error(pw.error.issues.map((i) => i.message).join('\n'));
  process.exit(1);
}

const handle = createDatabase(config.DATABASE_URL, { max: 2, applicationName: 'projecthub-admin-cli' });
try {
  await migrateDatabase(handle.db);
  const roleIds = await getSystemRoleIds(handle.db, ['super_admin']);
  const superAdmin = roleIds.super_admin;
  if (!superAdmin) throw new Error('super_admin role missing after migration');
  const slug = values['org-slug']?.trim() || slugify(orgName);
  const passwordHash = await hashPassword(password);

  await handle.db.transaction(async (tx) => {
    let org = (await tx.select().from(organizations).where(eq(organizations.slug, slug)))[0];
    if (!org) {
      org = (await tx.insert(organizations).values({ name: orgName, slug }).returning())[0]!;
      console.log(`Organization created: ${org.name} (${org.slug})`);
    }
    const existing = (await tx.select().from(users).where(sql`lower(${users.email}) = ${email}`))[0];
    let userId: string;
    if (existing) {
      await tx.update(users).set({ passwordHash, status: 'active', displayName: name }).where(eq(users.id, existing.id));
      userId = existing.id;
      console.log(`Existing user updated: ${email}`);
    } else {
      const u = (
        await tx
          .insert(users)
          .values({ email, displayName: name, passwordHash, status: 'active', emailVerifiedAt: new Date(), avatarColor: '#7A3EA8' })
          .returning()
      )[0]!;
      userId = u.id;
      console.log(`User created: ${email}`);
    }
    await tx.insert(organizationMembers).values({ organizationId: org.id, userId }).onConflictDoNothing();
    await tx.insert(organizationMemberRoles).values({ organizationId: org.id, userId, roleId: superAdmin }).onConflictDoNothing();
    await tx.insert(auditEvents).values({
      organizationId: org.id,
      actorType: 'system',
      actorLabel: 'CLI',
      action: 'user.bootstrap_admin',
      resourceType: 'user',
      resourceId: userId,
      metadata: { email },
    });
  });
  console.log(`Super Admin ready. Sign in at ${config.APP_URL}/login`);
} catch (e) {
  console.error(`Failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await handle.close();
}
