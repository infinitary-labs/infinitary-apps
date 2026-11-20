/**
 * One read of each signed-in Codex and Grok account's OWN model list, with
 * the verdict the app's safety rail would give it (docs/model-lists.md,
 * "The live check"). This module imports the app core, so the CLI
 * (`scripts/check-account-models.ts`) loads it through the Vite module
 * runner; vitest imports it directly.
 *
 * It touches exactly what the app itself touches for these reads and
 * nothing else: resolving an account's auth may renew an expired token in
 * that account's own store (as a quota read does), and creating its Pi
 * runtime keeps the pi.dev overlay cache beside it. It opens no database,
 * starts no task, runs no turn, and prints model ids only - never a token
 * or a header.
 */

import { STARTER_SLOTS } from "../src/shared/modelSlots.ts";
import { codexListReader, grokListReader, railVerdict } from "../src/core/models/piAccountLists.ts";
import type { CatalogReader, CatalogReadResult } from "../src/core/models/servedModels.ts";
import { appPathsFor } from "../src/core/paths.ts";
import { AccountVault } from "../src/core/pi/accountVault.ts";
import { PiAccountBackend } from "../src/core/pi/piAccountBackend.ts";

export const CHECKED_PROVIDERS = ["openai-codex", "xai"] as const;

export type AccountModelsReport = {
  providerId: string;
  accountLabel: string;
  result: CatalogReadResult;
  /** What Pi's catalog serves this account, unfiltered; undefined when it would not load. */
  piIds?: string[];
  /** The rail over the starter rows: would the app trust this answer to filter? */
  rail?: { ok: true } | { ok: false; detail: string };
};

export type AccountModelsDeps = {
  readers?: Partial<Record<(typeof CHECKED_PROVIDERS)[number], CatalogReader>>;
};

export async function readAccountModels(
  userDataDir: string,
  deps: AccountModelsDeps = {},
): Promise<AccountModelsReport[]> {
  const paths = appPathsFor(userDataDir);
  const vault = AccountVault.create(paths, {
    pi: new PiAccountBackend({ modelsPath: paths.modelsPath }),
  });
  const resolveAuth = (id: string) => vault.resolveForQuota(id);
  const readers: Record<string, CatalogReader> = {
    "openai-codex": deps.readers?.["openai-codex"] ?? codexListReader({ resolveAuth }),
    xai: deps.readers?.xai ?? grokListReader({ resolveAuth }),
  };
  const reports: AccountModelsReport[] = [];
  for (const account of vault.list()) {
    const reader = readers[account.providerId];
    if (!reader || !account.enabled) continue;
    const accountRef = { accountId: account.id, providerId: account.providerId };
    await vault.runtimeFor(account.id).catch(() => undefined);
    const piIds = vault.piCatalogIds(account.id);
    const result = await reader(accountRef).catch(
      (caught): CatalogReadResult => ({
        status: "failed",
        reason: "error",
        detail: caught instanceof Error ? caught.message : String(caught),
      }),
    );
    reports.push({
      providerId: account.providerId,
      accountLabel: account.label,
      result,
      ...(piIds ? { piIds } : {}),
      ...(result.status === "ok"
        ? {
            rail: railVerdict({
              answer: result.models,
              protectedIds: Object.keys(STARTER_SLOTS[account.providerId] ?? {}),
              piIds,
            }),
          }
        : {}),
    });
  }
  return reports;
}

/** The report as the lines the CLI prints: statuses and model ids, nothing secret. */
export function describeAccountModels(reports: readonly AccountModelsReport[]): string {
  if (reports.length === 0) return "no enabled Codex or Grok account in this profile";
  const lines: string[] = [];
  for (const report of reports) {
    const head = `${report.providerId} (${report.accountLabel})`;
    const { result } = report;
    if (result.status !== "ok") {
      const why =
        result.status === "failed"
          ? `${result.reason}${result.detail ? `: ${result.detail}` : ""}`
          : result.status;
      lines.push(`${head}: not read (${why}) - the app would serve Pi's catalog unfiltered`);
      continue;
    }
    const named = new Set(result.models.map((model) => model.id));
    lines.push(`${head}: ${result.models.length} models`);
    lines.push(`  ids: ${[...named].sort().join(", ")}`);
    if (report.rail?.ok) {
      const hidden = (report.piIds ?? []).filter((id) => !named.has(id)).sort();
      lines.push(
        `  rail: accepted - the filter would hide ${hidden.length > 0 ? hidden.join(", ") : "nothing"}`,
      );
    } else if (report.rail) {
      lines.push(`  rail: refused (${report.rail.detail}) - the app would serve Pi's catalog unfiltered`);
    }
  }
  return lines.join("\n");
}
