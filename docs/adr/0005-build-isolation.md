# 0005 — Build and preview isolation (deviation from the spec)

**Status:** amended 2026-10-09; constrained container runner available for trusted builds

**Context.** The spec asks for every build to run in a throwaway container. The first deployment target is a single
8 GB server, and the hub must also work on hosts without a container runtime.

**Decision.** Builds and app previews run as child processes of the worker, each in its own workspace directory
that is deleted afterwards, with a scrubbed environment (the hub's database URL, encryption key, AI keys, SMTP and
other settings are removed; only the project's own secrets for that scope are added), a timeout per command,
process-tree kill on cancel/timeout, previews bound to 127.0.0.1 and reachable only through the authenticated
preview gateway. In the container deployment the worker runs as an unprivileged user in its own container.

A standalone worker may now opt into `BUILD_EXECUTOR=container`. Each install/build/test command then runs in an
ephemeral container with a read-only root filesystem, non-root UID, dropped capabilities, no-new-privileges,
CPU/RAM/PID/time limits and no Docker socket. Install steps may use the bridge network; build and test steps use
`--network none`. Image pulling is forbidden during jobs (`--pull never`), so an operator must pre-pull the pinned
image. Project-scoped variables are passed by name and hub process secrets are not forwarded. Containers are
removed on success, failure, timeout and cancellation; a heartbeat/status reconciler removes managed leftovers
after a worker crash.

**Consequences.** Host mode still runs project code with the worker's operating-system user and is allowed only for
explicitly trusted projects. Container mode materially reduces accidental and compromised-build impact, but a
shared-kernel container is not a complete boundary for arbitrary hostile code. Imported Git/ZIP sources therefore
remain blocked until an authorized operator marks them trusted. A future hostile-code tier must use a dedicated
rootless runner host or microVM, with no Project Hub data mount and no daemon socket exposed to the job.
