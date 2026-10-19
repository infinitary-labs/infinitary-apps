import type { Card } from "@shared/cards";
import { AUTOMATIC_COMPUTER } from "@shared/placement";
import type { RepoView } from "@shared/repos";
import { describe, expect, it } from "vitest";
import type { CoreDispatch } from "../dispatcher";
import { ProjectChanges } from "./projectChanges";
import type { RepoRegistry } from "./repoRegistry";

const WEBSITE: RepoView = {
  id: "repo-website",
  name: "website",
  path: "/Users/someone/code/website",
  setupKind: "adopt",
  kind: "project",
  origin: "https://github.com/someone/website.git",
  host: { kind: "github", name: "github.com" },
  delivery: "direct-pr",
  autonomy: false,
  rigor: null,
  runsOn: null,
};

// The design skill's ChangeCard: "The primary Apply change and ghost Not now
// are the only buttons" (INF-407).
describe("the app's exact-change card", () => {
  it("offers a primary Apply change as the default and a ghost Not now", async () => {
    const raised: Omit<Card, "author" | "priority" | "status" | "createdAt">[] = [];
    const changes = new ProjectChanges({
      repos: { get: (id: string) => (id === WEBSITE.id ? WEBSITE : undefined) } as RepoRegistry,
      devices: () => [],
      raiseCard: (card) => raised.push(card),
      tell: () => {},
    });
    changes.bindDispatch((async (channel: string) => {
      if (channel === "inf:repos:list") return [WEBSITE];
      throw new Error(`No ${channel} here.`);
    }) as CoreDispatch);
    // The first mate asks, with no captain words behind it, to run website
    // on whichever computer has room.
    const { cardId } = await changes.request(
      "project-runs-on",
      { repoId: WEBSITE.id, deviceId: AUTOMATIC_COMPUTER },
      { kind: "firstmate", wake: "other" },
    );
    expect(cardId).toBe(raised[0]?.id);
    expect(
      raised[0]?.actions.map(({ label, variant, default: isDefault }) => ({
        label,
        variant,
        default: isDefault === true,
      })),
    ).toEqual([
      { label: "Apply change", variant: "primary", default: true },
      { label: "Not now", variant: "ghost", default: false },
    ]);
  });
});
