import { describe, expect, it } from "vitest";
import { forgeHostIntegration } from "./forgeHosts";

/**
 * Whether a forge server's sign-in is here, for a first launch that may follow its first mate's
 * computer (docs/view.md, "Following along"; the review of INF-5409): read from the store's own
 * listing, never a view that opens each token-bearing file.
 */
describe("forgeHostIntegration saved", () => {
  /** A sign-in store whose view and token reads fail the test, listing `present`. */
  const binding = (kind: "gitlab" | "github-enterprise", present: string[] | null) =>
    forgeHostIntegration(kind, {
      signIns: {
        view: () => {
          throw new Error("built a view of the sign-ins");
        },
        presentHosts: () => present,
      } as never,
      gateway: () => {
        throw new Error("asked a host");
      },
    });

  it("counts a server's sign-in file without opening it", () => {
    expect(binding("github-enterprise", ["github.example.com"]).saved?.()).toBe(true);
    expect(binding("gitlab", ["gitlab.com"]).saved?.()).toBe(true);
  });

  it("counts none only from a listing that found none of its hosts", () => {
    expect(binding("github-enterprise", []).saved?.()).toBe(false);
    // GitHub's public host is its own integration's, not a server row.
    expect(binding("github-enterprise", ["github.com"]).saved?.()).toBe(false);
    // A store that cannot be listed may hold one.
    expect(binding("gitlab", null).saved?.()).toBe(true);
  });
});
