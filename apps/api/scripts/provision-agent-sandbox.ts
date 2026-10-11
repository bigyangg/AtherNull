// ADR-0015 — provision (or refresh) one organization's agent sandbox by hand:
//
//   pnpm --filter @athernull/api sandbox:provision -- --org <organizationId>
//
// Normally the sandbox provisioner (scripts/sandbox-provisioner.ts) does this
// automatically when someone in the organization first opens the canvas.

import { db } from "../src/db.js";
import { provisionOrgSandbox } from "../src/sandbox/provision.js";

const i = process.argv.indexOf("--org");
const organizationId = i >= 0 ? process.argv[i + 1] : undefined;

provisionOrgSandbox(organizationId ?? "")
  .then(() => db.destroy())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await db.destroy();
    process.exit(1);
  });
