import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountRecord } from "../../src/core/pi/accountVault";

/**
 * INF-2394 measure 4: the vault layout and Pi credential envelope have one fixture owner.
 * Values, enabled states, labels and deliberately retired providers remain the journey's input.
 * @journey-area src/core/pi/accountVault.ts
 * @journey-area src/core/pi/piAccountBackend.ts
 */

type FixtureAccount = Omit<AccountRecord, "kind"> & { kind: string };
type FileOptions = { mode?: number };
type DirectoryOptions = { recursive?: boolean; mode?: number };

export function seedAccountRoot(userDataDir: string): void {
  mkdirSync(join(userDataDir, "accounts"), { recursive: true, mode: 0o700 });
}

export function seedAccountStore(
  userDataDir: string,
  providerId: string,
  accountId: string,
  options: DirectoryOptions = { recursive: true, mode: 0o700 },
): void {
  mkdirSync(join(userDataDir, "accounts", providerId, accountId), options);
}

export function seedAccountRegistry(
  userDataDir: string,
  accounts: readonly FixtureAccount[],
  pins: Record<string, string> = {},
  options: FileOptions = { mode: 0o600 },
): void {
  writeFileSync(
    join(userDataDir, "accounts", "registry.json"),
    JSON.stringify({ version: 1, accounts, pins }),
    options,
  );
}

/** Entries use the provider's actual Pi auth format, including expired or refused readings. */
export function seedAccountAuth(
  userDataDir: string,
  providerId: string,
  accountId: string,
  entries: Record<string, unknown>,
  options: FileOptions = { mode: 0o600 },
): void {
  writeFileSync(
    join(userDataDir, "accounts", providerId, accountId, "auth.json"),
    JSON.stringify(entries),
    options,
  );
}

/** The common launcher supplies a local provider catalog, never a signed-in account. */
export function seedMockModelCatalog(userDataDir: string, modelsJson: string): void {
  mkdirSync(join(userDataDir, "auth"), { recursive: true });
  writeFileSync(join(userDataDir, "auth", "models.json"), modelsJson);
}
