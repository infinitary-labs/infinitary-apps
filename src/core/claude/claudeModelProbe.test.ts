import { describe, expect, it, vi } from "vitest";
import { checkCatalog } from "../models/catalogChecks";
import { parseStatus } from "./claudeAuth";
import { claudeClientVersion, resolveClaudeExecutable, runClaude } from "./claudeCli";
import {
  canonicalClaudeModelIds,
  claudeCatalogIsBuiltInPicker,
  claudeCatalogIsOutdated,
  readClaudeModelCatalog,
} from "./claudeModelCatalog";
import { CLAUDE_MODELS } from "./claudeModels";
import { defaultClaudeConfigDir } from "./claudeQuota";

// Integration budget (docs/test-cohorts.md): the installed Claude client,
// 1.0 s at its fastest measured run.
vi.setConfig({ testTimeout: 10_000 });

/**
 * The live Claude model-catalog probe: do CLAUDE_MODELS and the starter map
 * still name what this machine's Claude subscription can actually run?
 *
 * CLAUDE_MODELS is the shipped catalog the app serves until its own
 * runtime read of this same catalog lands, and whenever that read fails
 * (docs/model-lists.md). It is held to the shared contract
 * (`src/core/models/catalogChecks.ts`), which fails on what would break or
 * quietly stale a default and never on a mere catalog addition:
 *
 * - a starter or listed id the client no longer serves - it would fail at
 *   spawn, in front of a task;
 * - a family whose newest generation CLAUDE_MODELS does not name - the
 *   FI3-74 shape, where Fable was reachable and never offered;
 * - a starter a generation behind its family, unless HELD_BACK says why.
 *
 * Earlier generations the client re-lists (it began answering six of them
 * on 2026-09-23) are digest only: printed, never a failure, reachable by
 * name in the app.
 *
 * The probe costs nothing. It opens a session over an input stream that
 * never yields, so no turn starts and no tokens are spent; it reads the
 * model list and closes. It signs nobody in and opens no browser. It runs
 * under the production credential boundary: the installed executable (or
 * INFINITARY_CLAUDE_CLI), the machine's default login with CLAUDE_CONFIG_DIR
 * unset, and no ambient key. Since F14 the app ships no client, so this is
 * the one suite that deliberately spawns the developer's own Claude Code.
 *
 * It is skipped, never passed, where it cannot run: no client installed (a
 * CI runner, or a Mac without Claude Code), or nobody signed in. A probe that
 * could not read the catalog must not read as a validation. An unreadable
 * catalog - a client that answers nothing - fails.
 *
 * The comparison itself is covered hermetically in claudeModelCatalog.test.ts.
 * The recorded run and how to repeat it live in docs/claude-model-probe.md.
 */

const executable = resolveClaudeExecutable();
const describeWithClaude = executable ? describe : describe.skip;

/** Long enough for a cold start of a 300MB single-file client, twice over. */
const PROBE_TIMEOUT_MS = 120_000;

/** Whether the machine's default Claude login is connected right now. */
async function signedIn(): Promise<boolean> {
  try {
    const result = await runClaude(["auth", "status", "--json"], defaultClaudeConfigDir());
    return parseStatus(result.stdout).connected;
  } catch {
    return false;
  }
}

describeWithClaude("the routed Claude models (live catalog probe)", () => {
  it(
    "keeps every default and every family's newest generation served and named",
    async (context) => {
      if (!(await signedIn())) {
        // No connected subscription: there is no catalog to compare against,
        // and a pass here would be a lie about a list nobody checked.
        context.skip("no Claude subscription is connected on this machine");
        return;
      }
      const rows = await readClaudeModelCatalog();
      const served = canonicalClaudeModelIds(rows);
      // An empty answer is unreadable, not "serves nothing": failing here is
      // the point, because the alternative is a green check on no evidence.
      expect(served.length, "the client listed no models at all").toBeGreaterThan(0);

      if (
        claudeCatalogIsOutdated(
          rows,
          executable ? await claudeClientVersion(executable) : undefined,
        )
      ) {
        context.skip(
          "client catalog predates Haiku 5.5; use Claude Code 2.1.293 or later for catalog validation",
        );
        return;
      }
      if (claudeCatalogIsBuiltInPicker(rows)) {
        // Aliases only, the shape of the client's built-in picker: it says
        // nothing about what the account serves.
        context.skip(
          "client answered with aliases only (its built-in picker); run the probe again",
        );
        return;
      }
      const result = checkCatalog({
        providerId: "anthropic-claude",
        served,
        shipped: CLAUDE_MODELS.map((model) => model.id),
        namesEveryHead: true,
      });
      // Model ids only - nothing about the account is read or printed.
      console.info(result.digest);
      expect(result.failures, result.failures.join("\n")).toEqual([]);
    },
    PROBE_TIMEOUT_MS,
  );
});
