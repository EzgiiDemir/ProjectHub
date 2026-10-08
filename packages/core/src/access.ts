import { and, eq, inArray, sql } from 'drizzle-orm';
import { ORG_ONLY_PERMISSIONS, type Permission } from '@projecthub/contracts';
import {
  organizationMemberRoles,
  projectMembers,
  projects,
  rolePermissions,
  users,
  type Executor,
} from '@projecthub/database';

/** Organization-wide permissions of a user (union of their organization roles). */
export async function getOrgPermissions(db: Executor, organizationId: string, userId: string): Promise<Set<Permission>> {
  const rows = await db
    .selectDistinct({ key: rolePermissions.permissionKey })
    .from(organizationMemberRoles)
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, organizationMemberRoles.roleId))
    .where(and(eq(organizationMemberRoles.organizationId, organizationId), eq(organizationMemberRoles.userId, userId)));
  return new Set(rows.map((r) => r.key as Permission));
}

export interface ProjectAccess {
  isMember: boolean;
  canSee: boolean;
  permissions: Set<Permission>;
}

/**
 * Effective permissions inside one project:
 *  - visible to members, or to holders of project.read.all;
 *  - permissions = organization role permissions ∪ project role permissions (if the member has one).
 * Organization-only permissions are never granted through a project role.
 */
export async function getProjectAccess(
  db: Executor,
  input: { organizationId: string; userId: string; projectId: string; orgPermissions?: Set<Permission> },
): Promise<ProjectAccess> {
  const orgPerms = input.orgPermissions ?? (await getOrgPermissions(db, input.organizationId, input.userId));
  const member = await db
    .select({ roleId: projectMembers.roleId })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        eq(projectMembers.projectId, input.projectId),
        eq(projectMembers.userId, input.userId),
        eq(projects.organizationId, input.organizationId),
      ),
    );
  const isMember = member.length > 0;
  const permissions = new Set<Permission>(orgPerms);
  const roleId = member[0]?.roleId;
  if (roleId) {
    const extra = await db.select({ key: rolePermissions.permissionKey }).from(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    for (const r of extra) if (!ORG_ONLY_PERMISSIONS.includes(r.key as Permission)) permissions.add(r.key as Permission);
  }
  const canSee = isMember || orgPerms.has('project.read.all');
  if (!canSee) return { isMember, canSee, permissions: new Set() };
  if (!permissions.has('project.read')) permissions.add('project.read');
  return { isMember, canSee, permissions };
}

/** Users of a project that hold a given permission there (used for notifications and approvals). */
export async function usersWithProjectPermission(db: Executor, organizationId: string, projectId: string, permission: Permission): Promise<string[]> {
  const result = await db.execute<{ user_id: string }>(sql`
    SELECT DISTINCT u.id AS user_id
    FROM users u
    JOIN organization_members om ON om.user_id = u.id AND om.organization_id = ${organizationId} AND om.status = 'active'
    LEFT JOIN project_members pm ON pm.user_id = u.id AND pm.project_id = ${projectId}
    WHERE u.status = 'active'
      AND (
        (pm.user_id IS NOT NULL AND (
          EXISTS (SELECT 1 FROM organization_member_roles omr JOIN role_permissions rp ON rp.role_id = omr.role_id
                  WHERE omr.organization_id = ${organizationId} AND omr.user_id = u.id AND rp.permission_key = ${permission})
          OR EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = pm.role_id AND rp.permission_key = ${permission})
        ))
        OR (pm.user_id IS NULL AND EXISTS (
          SELECT 1 FROM organization_member_roles omr JOIN role_permissions rp ON rp.role_id = omr.role_id
          WHERE omr.organization_id = ${organizationId} AND omr.user_id = u.id AND rp.permission_key = 'project.read.all'
        ) AND EXISTS (
          SELECT 1 FROM organization_member_roles omr JOIN role_permissions rp ON rp.role_id = omr.role_id
          WHERE omr.organization_id = ${organizationId} AND omr.user_id = u.id AND rp.permission_key = ${permission}
        ))
      )`);
  return result.rows.map((r) => r.user_id);
}

export async function activeUserIds(db: Executor, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.status, 'active')));
  return rows.map((r) => r.id);
}
