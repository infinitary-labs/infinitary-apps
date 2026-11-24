import { describe, expect, it } from "vitest";
import { publicProjectRead } from "./readerPublicReads";

describe("which of a reader's project reads anyone may see", () => {
  // The captain's answer on INF-6432's review: anything not known to be
  // public holds the reader. GitLab can make an issue confidential and
  // Bitbucket can make an area members-only on a public project.
  it("knows no GitLab or Bitbucket path as public, even issues and pull requests", () => {
    expect(publicProjectRead("gitlab", "issues/7")).toBe(false);
    expect(publicProjectRead("gitlab", "")).toBe(false);
    expect(publicProjectRead("bitbucket", "pullrequests/3")).toBe(false);
    expect(publicProjectRead("bitbucket", "api/pull-requests/3")).toBe(false);
  });

  it("knows a GitHub area as public by its whole leading segments, not a prefix of one", () => {
    expect(publicProjectRead("github", "actions/runs/39631227000/jobs")).toBe(true);
    expect(publicProjectRead("github", "actions/variables")).toBe(false);
    expect(publicProjectRead("github", "issues-secret")).toBe(false);
    expect(publicProjectRead("github", "secret-scanning/alerts")).toBe(false);
  });

  // INF-6530's F10: drafts, protection and an unsent review are read only by
  // those with access, so only the published forms of each area count.
  it("counts published releases, branches and pull requests as public, but not drafts, protection or reviews", () => {
    expect(publicProjectRead("github", "releases/latest")).toBe(true);
    expect(publicProjectRead("github", "releases/tags/v0.8.9")).toBe(true);
    expect(publicProjectRead("github", "releases")).toBe(false);
    expect(publicProjectRead("github", "releases/183447521")).toBe(false);
    expect(publicProjectRead("github", "releases/183447521/assets")).toBe(false);
    expect(publicProjectRead("github", "branches/main")).toBe(true);
    expect(publicProjectRead("github", "branches/main/protection")).toBe(false);
    expect(publicProjectRead("github", "branches/main/protection/required_status_checks")).toBe(
      false,
    );
    expect(publicProjectRead("github", "tags/protection")).toBe(false);
    expect(publicProjectRead("github", "pulls/250/files")).toBe(true);
    expect(publicProjectRead("github", "pulls/250/reviews")).toBe(false);
  });
});
