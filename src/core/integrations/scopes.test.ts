import { describe, expect, it } from "vitest";
import { calendarScope, forgeScope, recipientsScope } from "./scopes";

/**
 * What one Allow for the rest of this task covers (INF-2993, the captain's
 * pick "The same action, kind of request and place"): the calls of finding
 * 3's run, which wrote into one throwaway repository, read as their places.
 */
describe("Allow for the rest of this task's place (INF-2993)", () => {
  const github = forgeScope("github");

  it("names a GitHub repository in lower case with its method, whatever the rest of the path", () => {
    const pulls = github({ method: "POST", path: "/repos/Octo/Queue-Proof-4ca5/pulls" });
    expect(pulls).toEqual({
      key: "POST /repos/octo/queue-proof-4ca5",
      words: "POST requests to octo/queue-proof-4ca5",
    });
    expect(
      github({ method: "POST", path: "repos/octo/queue-proof-4ca5/statuses/abc?per_page=1" }).key,
    ).toBe(pulls.key);
    // Another kind of request to the same repository, or another repository, is another scope.
    expect(github({ method: "DELETE", path: "/repos/octo/queue-proof-4ca5" }).key).not.toBe(
      pulls.key,
    );
    expect(github({ method: "POST", path: "/repos/octo/other/pulls" }).key).not.toBe(pulls.key);
    // A read names the method it defaults to.
    expect(github({ path: "/repos/octo/queue-proof-4ca5/pulls" }).key).toBe(
      "GET /repos/octo/queue-proof-4ca5",
    );
  });

  it("keeps a path outside a repository, or one that could leave it, as its own exact place", () => {
    expect(github({ method: "POST", path: "/user/repos?visibility=private" })).toEqual({
      key: "POST /user/repos",
      words: "POST requests to /user/repos",
    });
    for (const path of [
      "/repos/octo/queue-proof-4ca5/../../other/pulls",
      "/repos/octo/%2e%2e/other/pulls",
      "/repos/octo%2Fqueue-proof-4ca5/pulls",
      "/repos/octo/./queue-proof-4ca5",
    ])
      expect(github({ method: "POST", path }).key).toBe(`POST ${path}`);
  });

  it("names a GitLab project by its id or its encoded path", () => {
    const gitlab = forgeScope("gitlab");
    expect(gitlab({ method: "POST", path: "/projects/Group%2FMeter/issues" })).toEqual({
      key: "POST /projects/group%2fmeter",
      words: "POST requests to project group/meter",
    });
    expect(gitlab({ method: "PUT", path: "/projects/42/labels" }).key).toBe("PUT /projects/42");
    // A GitHub-shaped path on GitLab is no project.
    expect(gitlab({ method: "POST", path: "/repos/octo/meter/pulls" }).key).toBe(
      "POST /repos/octo/meter/pulls",
    );
  });

  it("names a calendar with whom it notifies, and a message by its recipients in any order", () => {
    expect(calendarScope({ event: {} })).toEqual(
      calendarScope({ calendar: "primary", send_updates: "none" }),
    );
    expect(calendarScope({ calendar: "primary", send_updates: "all" }).key).not.toBe(
      calendarScope({}).key,
    );
    expect(calendarScope({ calendar: "team@example.com" }).words).toBe(
      "events in the team@example.com calendar, notifying nobody",
    );
    const sent = recipientsScope({ to: ["Ada <ada@example.com>"], cc: ["sam@example.com"] });
    expect(recipientsScope({ to: ["sam@example.com", "ada <ADA@example.com>"] })).toEqual(sent);
    expect(recipientsScope({ to: ["ada <ada@example.com>"] }).key).not.toBe(sent.key);
  });
});
