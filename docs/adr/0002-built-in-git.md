# 0002 — Built-in Git server instead of Gitea/Forgejo/GitLab

**Status:** accepted

**Context.** Every project needs a hub-owned repository: web edits, AI branches, builds and versions reference
commits; imported projects keep a link to their upstream.

**Decision.** Bare repositories in `STORAGE_DIR/repos`, manipulated with Git plumbing (temporary index,
`commit-tree`, compare-and-swap `update-ref`, `merge-tree --write-tree`). Clone/push over HTTPS through
`git http-backend`, authenticated with personal access tokens and project permissions. Upstream sync fetches into a
staging namespace and only creates or fast-forwards branches — diverged branches are reported, never overwritten.

**Consequences.** No second user directory or permission model to keep in sync; every repository action is
audited in one place. Reviews are pull requests with approvals on the current head, a merge check and optional
branch protection (enforced for web edits, merges and `git push` through a pre-receive hook); teams that need a full
forge can keep it as the upstream and use *Kaynaktan güncelle*.
