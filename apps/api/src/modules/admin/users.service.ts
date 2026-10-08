import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { ALL_PERMISSIONS, type Permission } from '@projecthub/contracts';
import { audit, conflict, forbidden, invalid, notFound, type Actor } from '@projecthub/core';
import {
  auditEvents,
  organizationMemberRoles,
  organizationMembers,
  projectMembers,
  projects,
  rolePermissions,
  roles,
  sessions,
  teamMembers,
  teams,
  users,
  type Transaction,
} from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { Mailer } from '../../infra/mailer.js';
import { AuthService } from '../auth/auth.service.js';

const COLORS = ['#234E8C', '#2E7D4F', '#B5520F', '#7A3EA8', '#BE3B28', '#2563A8', '#1F6F5C', '#5B6772'];

@Injectable()
export class UsersService {
  constructor(
    private readonly ctx: Ctx,
    private readonly authService: AuthService,
    private readonly mailer: Mailer,
  ) {}

  async list(auth: AuthInfo) {
    const db = this.ctx.db;
    const rows = await db
      .select({ user: users, memberStatus: organizationMembers.status, joinedAt: organizationMembers.joinedAt })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.organizationId, auth.organizationId))
      .orderBy(users.displayName);
    const ids = rows.map((r) => r.user.id);
    if (!ids.length) return [];
    const roleRows = await db
      .select({ userId: organizationMemberRoles.userId, id: roles.id, key: roles.key, name: roles.name })
      .from(organizationMemberRoles)
      .innerJoin(roles, eq(roles.id, organizationMemberRoles.roleId))
      .where(and(eq(organizationMemberRoles.organizationId, auth.organizationId), inArray(organizationMemberRoles.userId, ids)));
    const projectCounts = await db
      .select({ userId: projectMembers.userId, n: count() })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(and(eq(projects.organizationId, auth.organizationId), inArray(projectMembers.userId, ids)))
      .groupBy(projectMembers.userId);
    const teamRows = await db
      .select({ userId: teamMembers.userId, name: teams.name })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(eq(teams.organizationId, auth.organizationId), inArray(teamMembers.userId, ids)));
    return rows.map((r) => ({
      id: r.user.id,
      email: r.user.email,
      displayName: r.user.displayName,
      title: r.user.title,
      avatarColor: r.user.avatarColor,
      status: r.user.status === 'active' && r.memberStatus !== 'active' ? 'suspended' : r.user.status,
      lastLoginAt: r.user.lastLoginAt,
      lastActivityAt: r.user.lastActivityAt,
      joinedAt: r.joinedAt,
      roles: roleRows.filter((x) => x.userId === r.user.id).map(({ id, key, name }) => ({ id, key, name })),
      teams: teamRows.filter((x) => x.userId === r.user.id).map((x) => x.name),
      projectCount: projectCounts.find((p) => p.userId === r.user.id)?.n ?? 0,
    }));
  }

  async detail(auth: AuthInfo, userId: string) {
    const list = await this.list(auth);
    const user = list.find((u) => u.id === userId);
    if (!user) throw notFound('Kullanıcı');
    const db = this.ctx.db;
    const memberships = await db
      .select({ id: projects.id, name: projects.name, slug: projects.slug, roleName: roles.name })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .leftJoin(roles, eq(roles.id, projectMembers.roleId))
      .where(and(eq(projectMembers.userId, userId), eq(projects.organizationId, auth.organizationId)));
    const activeSessions = await db
      .select({ id: sessions.id, ipAddress: sessions.ipAddress, userAgent: sessions.userAgent, lastSeenAt: sessions.lastSeenAt })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), sql`${sessions.expiresAt} > now()`))
      .orderBy(desc(sessions.lastSeenAt));
    const activity = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.organizationId, auth.organizationId), eq(auditEvents.actorId, userId)))
      .orderBy(desc(auditEvents.createdAt))
      .limit(50);
    const permissions = await db
      .selectDistinct({ key: rolePermissions.permissionKey })
      .from(organizationMemberRoles)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, organizationMemberRoles.roleId))
      .where(and(eq(organizationMemberRoles.organizationId, auth.organizationId), eq(organizationMemberRoles.userId, userId)));
    return { ...user, projects: memberships, sessions: activeSessions, activity, permissions: permissions.map((p) => p.key).sort() };
  }

  private async assertRolesUsable(auth: AuthInfo, roleIds: string[]) {
    const rows = await this.ctx.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(inArray(roles.id, roleIds), or(isNull(roles.organizationId), eq(roles.organizationId, auth.organizationId))));
    if (rows.length !== new Set(roleIds).size) throw invalid('Geçersiz rol seçimi');
  }

  /** Invites a user (or adds an existing account to this organization) and returns the invitation link. */
  async invite(auth: AuthInfo, input: { email: string; displayName: string; roleIds: string[] }, actor: Actor) {
    await this.assertRolesUsable(auth, input.roleIds);
    await this.assertCanGrant(auth, input.roleIds);
    const db = this.ctx.db;
    const email = input.email.trim().toLowerCase();
    const result = await db.transaction(async (tx) => {
      let user = (await tx.select().from(users).where(sql`lower(${users.email}) = ${email}`))[0];
      if (user) {
        const member = await tx
          .select()
          .from(organizationMembers)
          .where(and(eq(organizationMembers.organizationId, auth.organizationId), eq(organizationMembers.userId, user.id)));
        if (member.length) throw conflict('Bu e-posta ile bir kullanıcı zaten organizasyonda');
      } else {
        user = (
          await tx
            .insert(users)
            .values({ email, displayName: input.displayName, status: 'invited', avatarColor: COLORS[Math.floor(Math.random() * COLORS.length)]! })
            .returning()
        )[0]!;
      }
      await tx.insert(organizationMembers).values({ organizationId: auth.organizationId, userId: user.id, status: 'active' });
      await tx.insert(organizationMemberRoles).values(input.roleIds.map((roleId) => ({ organizationId: auth.organizationId, userId: user!.id, roleId })));
      await audit(tx, {
        organizationId: auth.organizationId,
        actor,
        action: 'user.invited',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { email, roleIds: input.roleIds },
      });
      return user;
    });
    let invitation: { url: string; expiresInHours: number } | null = null;
    let emailed = false;
    if (result.status === 'invited') {
      invitation = await this.authService.issueToken(result.id, auth.organizationId, 'invite', auth.user.id);
      emailed = await this.mailer.send(
        email,
        'Project Hub davetiyesi',
        `Merhaba ${input.displayName},\n\n${auth.user.displayName} sizi Project Hub'a davet etti. Hesabınızı etkinleştirmek için (${invitation.expiresInHours} saat geçerli):\n${invitation.url}\n`,
      );
    }
    return { id: result.id, invitationUrl: invitation?.url ?? null, emailed, existingAccount: result.status !== 'invited' };
  }

  async resendInvite(auth: AuthInfo, userId: string, actor: Actor) {
    const u = await this.memberOrThrow(auth, userId);
    if (u.status !== 'invited') throw invalid('Kullanıcı daveti zaten kabul etmiş');
    const link = await this.authService.issueToken(u.id, auth.organizationId, 'invite', auth.user.id);
    const emailed = await this.mailer.send(u.email, 'Project Hub davetiyesi', `Davet bağlantınız (${link.expiresInHours} saat geçerli):\n${link.url}\n`);
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: 'user.invite_resent', resourceType: 'user', resourceId: u.id });
    return { invitationUrl: link.url, emailed };
  }

  async passwordResetLink(auth: AuthInfo, userId: string, actor: Actor) {
    const u = await this.memberOrThrow(auth, userId);
    if (u.status !== 'active') throw invalid('Yalnızca aktif kullanıcılar için sıfırlama bağlantısı oluşturulabilir');
    const link = await this.authService.issueToken(u.id, auth.organizationId, 'password_reset', auth.user.id);
    const emailed = await this.mailer.send(u.email, 'Project Hub şifre sıfırlama', `Şifre sıfırlama bağlantınız (${link.expiresInHours} saat geçerli):\n${link.url}\n`);
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: 'user.password_reset_link_created', resourceType: 'user', resourceId: u.id });
    return { url: link.url, emailed };
  }

  private async memberOrThrow(auth: AuthInfo, userId: string) {
    const row = (
      await this.ctx.db
        .select({ user: users })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(eq(organizationMembers.organizationId, auth.organizationId), eq(organizationMembers.userId, userId)))
    )[0];
    if (!row) throw notFound('Kullanıcı');
    return row.user;
  }

  /** A user may only grant roles whose permissions they hold themselves (no privilege escalation). */
  private async assertCanGrant(auth: AuthInfo, roleIds: string[]) {
    const perms = await this.ctx.db.selectDistinct({ key: rolePermissions.permissionKey }).from(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
    const missing = perms.map((p) => p.key as Permission).filter((p) => !auth.orgPermissions.has(p));
    if (missing.length) throw forbidden(`Sahip olmadığınız yetkileri veremezsiniz: ${missing.join(', ')}`);
  }

  async update(
    auth: AuthInfo,
    userId: string,
    input: { displayName?: string; title?: string; status?: 'active' | 'suspended'; roleIds?: string[] },
    actor: Actor,
  ) {
    const target = await this.memberOrThrow(auth, userId);
    if (userId === auth.user.id && (input.status === 'suspended' || input.roleIds)) {
      throw forbidden('Kendi rolünüzü veya durumunuzu değiştiremezsiniz');
    }
    if (input.roleIds) {
      await this.assertRolesUsable(auth, input.roleIds);
      await this.assertCanGrant(auth, input.roleIds);
    }
    await this.ctx.db.transaction(async (tx) => {
      if (input.displayName || input.title !== undefined) {
        await tx
          .update(users)
          .set({ ...(input.displayName ? { displayName: input.displayName } : {}), ...(input.title !== undefined ? { title: input.title } : {}) })
          .where(eq(users.id, userId));
      }
      if (input.status) {
        await tx
          .update(organizationMembers)
          .set({ status: input.status })
          .where(and(eq(organizationMembers.organizationId, auth.organizationId), eq(organizationMembers.userId, userId)));
        if (input.status === 'suspended') {
          await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
        }
      }
      if (input.roleIds) {
        await tx
          .delete(organizationMemberRoles)
          .where(and(eq(organizationMemberRoles.organizationId, auth.organizationId), eq(organizationMemberRoles.userId, userId)));
        await tx.insert(organizationMemberRoles).values(input.roleIds.map((roleId) => ({ organizationId: auth.organizationId, userId, roleId })));
        await this.assertSuperAdminRemains(tx, auth.organizationId);
      }
      await audit(tx, {
        organizationId: auth.organizationId,
        actor,
        action: input.status === 'suspended' ? 'user.suspended' : input.status === 'active' ? 'user.reactivated' : input.roleIds ? 'user.roles_changed' : 'user.updated',
        resourceType: 'user',
        resourceId: userId,
        metadata: { email: target.email, ...input },
      });
    });
    return this.detail(auth, userId);
  }

  private async assertSuperAdminRemains(tx: Transaction, organizationId: string) {
    const r = await tx
      .select({ n: count() })
      .from(organizationMemberRoles)
      .innerJoin(roles, eq(roles.id, organizationMemberRoles.roleId))
      .innerJoin(organizationMembers, and(eq(organizationMembers.userId, organizationMemberRoles.userId), eq(organizationMembers.organizationId, organizationId)))
      .where(and(eq(organizationMemberRoles.organizationId, organizationId), eq(roles.key, 'super_admin'), isNull(roles.organizationId), eq(organizationMembers.status, 'active')));
    if ((r[0]?.n ?? 0) < 1) throw forbidden('Organizasyonda en az bir aktif Sistem Yöneticisi kalmalı');
  }

  async resetSessions(auth: AuthInfo, userId: string, actor: Actor) {
    await this.memberOrThrow(auth, userId);
    const r = await this.ctx.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: 'user.sessions_reset', resourceType: 'user', resourceId: userId, metadata: { revoked: r.length } });
    return { revoked: r.length };
  }

  /* ---------------- roles ---------------- */

  async listRoles(auth: AuthInfo) {
    const db = this.ctx.db;
    const rows = await db
      .select()
      .from(roles)
      .where(or(isNull(roles.organizationId), eq(roles.organizationId, auth.organizationId)))
      .orderBy(desc(roles.isSystem), roles.name);
    const perms = await db.select().from(rolePermissions).where(inArray(rolePermissions.roleId, rows.map((r) => r.id)));
    const usage = await db
      .select({ roleId: organizationMemberRoles.roleId, n: count() })
      .from(organizationMemberRoles)
      .where(eq(organizationMemberRoles.organizationId, auth.organizationId))
      .groupBy(organizationMemberRoles.roleId);
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.permissionKey),
      memberCount: usage.find((u) => u.roleId === r.id)?.n ?? 0,
    }));
  }

  async createRole(auth: AuthInfo, input: { name: string; description: string; permissions: Permission[] }, actor: Actor) {
    const missing = input.permissions.filter((p) => !auth.orgPermissions.has(p));
    if (missing.length) throw forbidden(`Sahip olmadığınız yetkileri role ekleyemezsiniz: ${missing.join(', ')}`);
    const key = `custom_${Date.now().toString(36)}`;
    const role = await this.ctx.db.transaction(async (tx) => {
      const r = (await tx.insert(roles).values({ organizationId: auth.organizationId, key, name: input.name, description: input.description }).returning())[0]!;
      if (input.permissions.length) await tx.insert(rolePermissions).values(input.permissions.map((permissionKey) => ({ roleId: r.id, permissionKey })));
      await audit(tx, { organizationId: auth.organizationId, actor, action: 'role.created', resourceType: 'role', resourceId: r.id, metadata: input });
      return r;
    });
    return role;
  }

  async updateRole(auth: AuthInfo, roleId: string, input: { name: string; description: string; permissions: Permission[] }, actor: Actor) {
    const role = (await this.ctx.db.select().from(roles).where(and(eq(roles.id, roleId), eq(roles.organizationId, auth.organizationId))))[0];
    if (!role) throw notFound('Rol');
    const missing = input.permissions.filter((p) => !auth.orgPermissions.has(p));
    if (missing.length) throw forbidden(`Sahip olmadığınız yetkileri role ekleyemezsiniz: ${missing.join(', ')}`);
    const invalidKeys = input.permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
    if (invalidKeys.length) throw invalid('Bilinmeyen yetki');
    await this.ctx.db.transaction(async (tx) => {
      await tx.update(roles).set({ name: input.name, description: input.description }).where(eq(roles.id, roleId));
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
      if (input.permissions.length) await tx.insert(rolePermissions).values(input.permissions.map((permissionKey) => ({ roleId, permissionKey })));
      await audit(tx, { organizationId: auth.organizationId, actor, action: 'role.updated', resourceType: 'role', resourceId: roleId, metadata: input });
    });
  }

  async deleteRole(auth: AuthInfo, roleId: string, actor: Actor) {
    const role = (await this.ctx.db.select().from(roles).where(and(eq(roles.id, roleId), eq(roles.organizationId, auth.organizationId))))[0];
    if (!role) throw notFound('Rol');
    const used = await this.ctx.db.select({ n: count() }).from(organizationMemberRoles).where(eq(organizationMemberRoles.roleId, roleId));
    if ((used[0]?.n ?? 0) > 0) throw conflict('Rol kullanıcılara atanmış; önce kullanıcılardan kaldırın');
    await this.ctx.db.update(projectMembers).set({ roleId: null }).where(eq(projectMembers.roleId, roleId));
    await this.ctx.db.delete(roles).where(eq(roles.id, roleId));
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: 'role.deleted', resourceType: 'role', resourceId: roleId, metadata: { name: role.name } });
  }

  /* ---------------- teams ---------------- */

  async listTeams(auth: AuthInfo) {
    const rows = await this.ctx.db.select().from(teams).where(eq(teams.organizationId, auth.organizationId)).orderBy(teams.name);
    const members = rows.length
      ? await this.ctx.db.select().from(teamMembers).where(inArray(teamMembers.teamId, rows.map((t) => t.id)))
      : [];
    return rows.map((t) => ({ id: t.id, name: t.name, memberIds: members.filter((m) => m.teamId === t.id).map((m) => m.userId) }));
  }

  async createTeam(auth: AuthInfo, name: string, actor: Actor) {
    const t = (await this.ctx.db.insert(teams).values({ organizationId: auth.organizationId, name }).returning())[0]!;
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: 'team.created', resourceType: 'team', resourceId: t.id, metadata: { name } });
    return t;
  }

  async setTeamMembers(auth: AuthInfo, teamId: string, userIds: string[], actor: Actor) {
    const t = (await this.ctx.db.select().from(teams).where(and(eq(teams.id, teamId), eq(teams.organizationId, auth.organizationId))))[0];
    if (!t) throw notFound('Ekip');
    const valid = userIds.length
      ? await this.ctx.db
          .select({ id: organizationMembers.userId })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.organizationId, auth.organizationId), inArray(organizationMembers.userId, userIds)))
      : [];
    await this.ctx.db.transaction(async (tx) => {
      await tx.delete(teamMembers).where(eq(teamMembers.teamId, teamId));
      if (valid.length) await tx.insert(teamMembers).values(valid.map((v) => ({ teamId, userId: v.id })));
      await audit(tx, { organizationId: auth.organizationId, actor, action: 'team.members_changed', resourceType: 'team', resourceId: teamId, metadata: { userIds: valid.map((v) => v.id) } });
    });
  }

  async deleteTeam(auth: AuthInfo, teamId: string, actor: Actor) {
    const r = await this.ctx.db.delete(teams).where(and(eq(teams.id, teamId), eq(teams.organizationId, auth.organizationId))).returning();
    if (!r.length) throw notFound('Ekip');
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: 'team.deleted', resourceType: 'team', resourceId: teamId, metadata: { name: r[0]!.name } });
  }
}
