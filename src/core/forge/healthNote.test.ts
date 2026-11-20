import { describe, expect, it } from "vitest";
import { forgeHealthNote } from "./healthNote";
import type { ForgeHealthChange } from "./signIns";

// INF-2299 finding 5: eleven "Could not reach GitLab" lines in a day for a
// gitlab.com sign-in no project lived on, each healed by the next check. The
// line is for a host a project lives on; a sign-in no project uses says nothing.
describe("the feed line a sign-in's health change writes", () => {
  // As forges/health.log recorded it: "gitlab.com sign-in ok -> unavailable (could not reach host)".
  const gitlabOut: ForgeHealthChange = {
    host: "gitlab.com",
    name: "GitLab",
    from: "ok",
    to: "unavailable",
  };

  it("says nothing for a sign-in no project uses", () => {
    expect(forgeHealthNote(gitlabOut, 0)).toBeNull();
  });

  it("says once that a host a project lives on is out of reach", () => {
    const githubOut = { ...gitlabOut, host: "github.com", name: "GitHub" };
    expect(forgeHealthNote(githubOut, 13)).toBe("Could not reach GitHub - trying again.");
    expect(forgeHealthNote({ ...githubOut, from: "unavailable" }, 13)).toBeNull();
    expect(forgeHealthNote({ ...githubOut, from: "unavailable", to: "ok" }, 13)).toBeNull();
  });
});
