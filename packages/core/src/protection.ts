import { branchProtectionSchema, type BranchProtection } from '@projecthub/contracts';

/** Branch protection stored in projects.settings.protection (absent = nothing protected). */
export function branchProtectionOf(settings: Record<string, unknown> | null | undefined): BranchProtection {
  const parsed = branchProtectionSchema.safeParse(settings?.protection ?? {});
  return parsed.success ? parsed.data : { branches: [], requiredApprovals: 1, requirePassingBuild: true };
}

export function isProtectedBranch(settings: Record<string, unknown> | null | undefined, branch: string): boolean {
  return branchProtectionOf(settings).branches.includes(branch);
}
