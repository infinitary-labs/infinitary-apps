import naming from "../../resources/runbooks/naming/runbook.json" with { type: "json" };
import { type NamingRule, runbookManifestSchema } from "../../src/shared/runbooks";

/**
 * The bundled Commit and PR naming runbook's rule, read from its own
 * manifest: what the app names and checks commits and pull requests by
 * while that runbook is on, as it is by default (docs/runbooks.md,
 * "Built-ins"). A test of the app as it ships passes it where the app
 * passes `runbooks.naming()`.
 */
const rule = runbookManifestSchema.parse(naming).naming;
if (!rule) throw new Error("The bundled naming runbook declares no naming rule.");
export const BUNDLED_NAMING: NamingRule = rule;
