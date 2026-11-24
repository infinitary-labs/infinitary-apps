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
});
