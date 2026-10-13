// Abuse and capacity limits for agent workspaces
// (docs/architecture/WORKSPACE_ONBOARDING.md). Shared by the API, which
// records requests, and the provisioner, which acts on them.

/** Workspace requests one user may have across organizations. */
export const MAX_REQUESTS_PER_USER = Number(process.env.SANDBOX_MAX_PER_USER ?? 3);
/** Sandboxes the host runs at most, organizations' and the warm pool's. */
export const MAX_RUNNING = Number(process.env.SANDBOX_MAX_RUNNING ?? 50);
