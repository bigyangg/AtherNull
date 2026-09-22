/**
 * SPIKE-B PARTIAL VENDOR (see MANIFEST.md "api/agent-server-config" row).
 * Upstream's file also builds live agent-server base URLs / working
 * directories from runtime config. Only the one constant `path-utils.ts`
 * reads is reproduced here, verbatim.
 */
export const DEFAULT_WORKING_DIR = "workspace/project";
