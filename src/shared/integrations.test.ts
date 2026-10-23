import { describe, expect, it } from "vitest";
import { integrationHostArrival, openedSection } from "./integrations";

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
});
