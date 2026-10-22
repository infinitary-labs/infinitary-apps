import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import { CUSTOM_API_PROVIDER_PREFIX } from "@shared/customApi";
import { hostEnv } from "../../src/core/hostEnv";
import { mcpIntegration } from "../../src/core/integrations/providers/mcp/mcpIntegration";
import { openDatabase } from "../../src/core/storage/db";
import { atUtilityQos } from "../../src/core/utilityQos";
import { INTEGRATION_KIND_NAMES } from "../../src/shared/integrations";

/**
 * A profile as an older release saved it (docs/saved-data-compatibility.md,
 * "Profiles saved by an older release"). A journey sets a profile up on this
 * build and quits; `asSavedByOlderRelease` rewrites what it saved into what the
 * release before each format change listed here wrote, and the next launch on
 * the same userData is the upgrade a person makes. A change that makes
 * something an earlier release saved read differently lists the earlier form
 * here, so every journey that opens an older profile meets it.
 */

/**
 * The check profile each release saved with a custom model's check, oldest
 * first (`customApiProfile`, src/core/pi/customApiProtocol.ts): 0.1.25 saved
 * text-tools-v1 for both protocols, 0.1.31 text-tools-usage-v2 for Chat, and
 * 0.2.0 text-tools-usage-v3 and text-tools-v2. A profile this build saves that
 * is not listed yet is newer than every listed one, so the last listed is the
 * previous release's.
 */
export const CUSTOM_CHECK_PROFILES = {
  "openai-completions": [
    "text-tools-v1",
    "text-tools-usage-v2",
    "text-tools-usage-v3",
    "pi-capabilities-v4",
  ],
  "openai-responses": ["text-tools-v1", "text-tools-v2", "pi-capabilities-v3"],
} as const;
type CustomProtocol = keyof typeof CUSTOM_CHECK_PROFILES;

/** The check profile the release before saved, for one this build saved. */
export function olderCheckProfile(protocol: CustomProtocol, profile: string): string {
  const profiles: readonly string[] = CUSTOM_CHECK_PROFILES[protocol];
  const at = profiles.indexOf(profile);
  const older = at < 0 ? profiles.at(-1) : profiles[at - 1];
  if (!older) throw new Error(`No release saved a ${protocol} check older than ${profile}`);
  return older;
}

export type OlderProfile = {
  /** Each custom model check rewritten: its connection, its model, and the profile before and after. */
  customChecks: { accountId: string; model: string; from: string; to: string }[];
};

/**
 * Rewrites a profile this build saved into the older release's form. Call it
 * while the app is stopped, between two launches on the same userData; what it
 * returns says what it rewrote, so a journey can tell it was not a no-op.
 */
export function asSavedByOlderRelease(userDataDir: string): OlderProfile {
  return { customChecks: olderCustomChecks(userDataDir) };
}

/**
 * Each custom connection's saved checks, under the check profile the release
 * before saved. The fingerprint keeps this build's value: the profile alone
 * marks a check as an older release's.
 */
function olderCustomChecks(userDataDir: string): OlderProfile["customChecks"] {
  const rewritten: OlderProfile["customChecks"] = [];
  const accounts = join(userDataDir, "accounts");
  if (!existsSync(accounts)) return rewritten;
  for (const provider of readdirSync(accounts)) {
    if (!provider.startsWith(CUSTOM_API_PROVIDER_PREFIX)) continue;
    for (const accountId of readdirSync(join(accounts, provider))) {
      const file = join(accounts, provider, accountId, "custom-auth.json");
      if (!existsSync(file)) continue;
      const saved = JSON.parse(readFileSync(file, "utf8")) as {
        input: { protocol: CustomProtocol };
        proofs: Record<string, { profile: string }>;
      };
      for (const [model, proof] of Object.entries(saved.proofs)) {
        const to = olderCheckProfile(saved.input.protocol, proof.profile);
        rewritten.push({ accountId, model, from: proof.profile, to });
        proof.profile = to;
      }
      writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
    }
  }
  return rewritten;
}

/** The fields this pre-migration-73 saved-card fixture owns, not today's writer's schema. */
type LegacyCard = Pick<
  Card,
  "id" | "title" | "author" | "meta" | "createdAt" | "priority" | "status" | "body" | "actions"
>;

/** A card saved before migration 73, while the app is stopped. */
export function saveKeepOpenCard(userDataDir: string, card: LegacyCard): void {
  const db = openDatabase(userDataDir, 72);
  try {
    // Seed the saved legacy format directly: today's CardStore requires later columns.
    db.prepare(
      `INSERT INTO cards (id, kind, author, priority, title, meta, body, actions_json, status, created_at)
       VALUES (?, 'card', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      card.id,
      card.author,
      card.priority,
      card.title,
      card.meta,
      card.body,
      JSON.stringify(card.actions),
      card.status,
      card.createdAt,
    );
  } finally {
    db.close();
  }
}

/** INF-882's existing installation: keep the real server's discovery, under its old allowed name. */
export async function seedLegacyGithubServer(userData: string, runs: string): Promise<void> {
  const server = mcpIntegration({
    root: join(userData, "integrations"),
    env: () => hostEnv(),
    belowUi: (file, args) => atUtilityQos(file, args),
    cwd: () => userData,
    version: "0.0.0-test",
    changed: () => {},
  });
  try {
    if (!server.add) throw new Error("MCP servers must support adding a connection");
    await server.add({ name: INTEGRATION_KIND_NAMES.github, runs });
  } finally {
    await server.close?.();
  }
}
