import { seedAccountRegistry, seedAccountStore } from "../../e2e/accountFixtures";
import type { HomeRead } from "../browserFreshHome";

/** What the account-feedback test's story reads back: the account's id, provider and name. */
type Input = { accountId: string; providerId: string; label: string };

/** The window sends no read with arguments for this home. */
export const asked: HomeRead[] = [];

/**
 * A truthful disconnected account, in the vault's own layout: the row
 * exists, but no key has been saved.
 */
export default function seed(userDataDir: string, { accountId, providerId, label }: Input): void {
  seedAccountStore(userDataDir, providerId, accountId, { recursive: true });
  seedAccountRegistry(
    userDataDir,
    [{ id: accountId, providerId, kind: "api_key", label, enabled: true, createdAt: 1 }],
    {},
    {},
  );
}
