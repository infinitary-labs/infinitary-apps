import { describe, expect, it } from "vitest";
import { DEVICE_SETUP_ACTIONS, deviceSetupActions } from "./deviceSetup";
import { integrationHostArrival, openedSection } from "./integrations";
import { signInPlace } from "./signIns";

// INF-1007 direction A: host cards from before the move reach the new home,
// and a new server handoff retains its explicitly selected kind and address.
describe("forge sign-in arrivals in Integrations", () => {
  it.each([
    "github.com",
    "gitlab.com",
    "gitlab.example.com",
    "github.example.com",
    "gitlab",
    "github-enterprise",
    "google",
  ])("opens Integrations for %s", (signIn) => {
    expect(openedSection({ target: "projects", signIn })).toBe("integrations");
  });
  it("preserves a new server's kind without guessing it from its address", () => {
    expect(integrationHostArrival("gitlab:code.example.com")).toEqual({
      kind: "gitlab",
      host: "code.example.com",
    });
    expect(integrationHostArrival("github-enterprise:code.example.com")).toEqual({
      kind: "github",
      host: "code.example.com",
    });
    expect(openedSection({ target: "projects", signIn: "gitlab:code.example.com" })).toBe(
      "integrations",
    );
    expect(integrationHostArrival("gitlab:../code.example.com")).toBeUndefined();
    expect(openedSection({ target: "projects" })).toBe("projects");
  });
  // The captain: another computer's own GitHub sign-in "should be only in
  // integrations tab", so the card that asks for it lands there too; the
  // host's "Sign in to GitHub on Mac mini" card names the same effect
  // (cardService.hostCards.test.ts).
  it("opens Integrations for another computer's own sign-in, as its setup card names it", () => {
    const actions = deviceSetupActions({
      deviceId: "dev-mini",
      place: signInPlace({ name: "Mac mini", onThisMac: false }),
      signIns: null,
      runs: [],
    });
    const github = actions.find((action) => action.id === DEVICE_SETUP_ACTIONS.github)?.effect;
    if (github?.kind !== "open") throw new Error("The setup card offers no GitHub sign-in");
    expect(github.forgeSignInOn).toEqual({ deviceId: "dev-mini", host: "github.com" });
    expect(openedSection(github)).toBe("integrations");
    // The computer's own subscriptions stay in Intelligence, and a project in Projects.
    const elsewhere = actions.flatMap(({ effect }) =>
      effect?.kind === "open" && effect !== github ? [openedSection(effect)] : [],
    );
    expect(elsewhere).toEqual(["subscriptions", "projects"]);
  });
});
