import { describe, expect, it } from "vitest";
import { nextPagePath, parseApiRequest } from "./api";
import { ForgeError } from "./forge";

const PROJECT = { owner: "Octo", name: "Meter" };
const parse = (method: string, path: string, bytes = 0) =>
  parseApiRequest(method, path, PROJECT, bytes);
const refused = (method: string, path: string, bytes = 0) => {
  try {
    parse(method, path, bytes);
  } catch (caught) {
    expect(caught).toBeInstanceOf(ForgeError);
    return (caught as ForgeError).message;
  }
  throw new Error(`${method} ${path} was not refused`);
};

describe("the gateway's request policy", () => {
  it("canonicalizes a project path and tells reads from writes", () => {
    expect(parse("get", "/repos/octo/meter/pulls/3/comments?per_page=50&page=2")).toMatchObject({
      method: "GET",
      write: false,
      path: "/repos/Octo/Meter/pulls/3/comments?per_page=50&page=2",
    });
    expect(parse("POST", "/repos/octo/meter/issues/1/comments", 20)).toMatchObject({
      write: true,
      rerun: false,
    });
  });

  it("recognizes the rerun routes and nothing else as a rerun", () => {
    for (const path of [
      "/repos/octo/meter/actions/runs/9/rerun",
      "/repos/octo/meter/actions/runs/9/rerun-failed-jobs",
      "/repos/octo/meter/actions/jobs/4/rerun",
    ]) {
      expect(parse("POST", path).rerun).toBe(true);
    }
    expect(parse("POST", "/repos/octo/meter/actions/runs/9/cancel").rerun).toBe(false);
    expect(parse("POST", "/repos/octo/meter/actions/runs/9/%72erun").rerun).toBe(true);
    expect(parse("GET", "/repos/octo/meter/actions/runs/9/rerun").rerun).toBe(false);
  });

  it("allows project operations without endpoint-specific restrictions", () => {
    for (const [method, rest] of [
      ["POST", "actions/workflows/verify.yml/dispatches"],
      ["POST", "actions/workflows/123/dispatches"],
      ["POST", "actions/workflows/verify.yml/%64ispatches"],
      ["PUT", "actions/workflows/verify.yml/disable"],
      ["PUT", "actions/workflows/verify.yml/enable"],
      ["POST", "actions/runs/9/cancel"],
      ["DELETE", "actions/runs/9"],
      ["POST", "dispatches"],
      ["GET", "actions/secrets"],
      ["PUT", "actions/secrets/DEPLOY_KEY"],
      ["GET", "actions/runners"],
      ["PUT", "branches/main/protection"],
      ["PUT", "collaborators/someone"],
      ["DELETE", "hooks/1"],
      ["POST", "keys"],
      ["GET", "invitations"],
      ["PATCH", "rulesets/1"],
      ["PUT", "actions/permissions"],
      ["POST", "transfer"],
      ["PUT", "environments/staging"],
      ["PUT", "contents/.github/workflows/ci.yml"],
      ["PATCH", ""],
      ["DELETE", ""],
    ]) {
      const path = `/repos/octo/meter${rest ? `/${rest}` : ""}`;
      expect(parse(method as string, path)).toMatchObject({
        method,
        path: path.replace("/octo/meter", "/Octo/Meter"),
      });
    }
  });

  it("lets a read reach the account and organizations, and routes every write there as not the project's", () => {
    for (const path of [
      "/user",
      "/user/keys",
      "/user/emails",
      "/authorizations",
      "/orgs/octo/members/someone",
      "/orgs/octo/actions/permissions",
      "/enterprises/octo/settings/billing",
    ]) {
      for (const method of ["GET", "HEAD"]) {
        expect(parse(method, path)).toMatchObject({ write: false, path });
      }
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(parse(method, path)).toMatchObject({ write: true, own: false, path });
      }
    }
  });

  it("routes another project's write as not the project's own, and refuses a caller's host and GraphQL", () => {
    expect(parse("PATCH", "/repos/octo/other/pulls/1")).toMatchObject({
      write: true,
      own: false,
      path: "/repos/octo/other/pulls/1",
    });
    expect(parse("PATCH", "/repos/octo/meter/pulls/1")).toMatchObject({ own: true });
    expect(refused("GET", "https://api.github.com/repos/octo/meter/pulls")).toContain("relative");
    expect(refused("GET", "/graphql")).toContain("GraphQL");
    expect(refused("POST", "/graphql", 2)).toContain("GraphQL");
  });

  it("lets a read reach any repository, the repo lists, organizations and search", () => {
    expect(parse("GET", "/repos/other/thing/issues?state=open&per_page=100")).toMatchObject({
      write: false,
      path: "/repos/other/thing/issues?state=open&per_page=100",
    });
    expect(parse("HEAD", "/repos/octo/meter/pulls")).toMatchObject({
      path: "/repos/Octo/Meter/pulls",
    });
    for (const path of [
      "/user/repos?sort=updated&per_page=100&page=2",
      "/user/orgs",
      "/user/memberships/orgs",
      "/users/someone",
      "/users/someone/repos",
      "/orgs/acme",
      "/orgs/acme/repos?type=private",
      "/search/repositories?q=meter+lab+in%3Aname",
      "/search/code?q=addClass+repo%3Aacme%2Fsite",
      "/issues?filter=assigned",
    ]) {
      expect(parse("GET", path)).toMatchObject({ write: false, path });
    }
  });

  it("reads whatever the sign-in may read, and routes a write anywhere but the project as not its own", () => {
    for (const path of [
      "/user",
      "/user/keys",
      "/user/gpg_keys",
      "/user/emails",
      "/users/someone/keys",
      "/orgs/acme/members",
      "/orgs/acme/actions/secrets",
      "/orgs/acme/hooks",
      "/notifications",
      "/app",
      "/applications/x/token",
      "/repositories/1/pulls?page=2",
    ]) {
      expect(parse("GET", path)).toMatchObject({ write: false, path });
    }
    expect(refused("GET", "/repos/other")).toContain("/repos/{owner}/{repo}");
    expect(parse("POST", "/repos/other/thing/issues", 2)).toMatchObject({ own: false });
    expect(parse("POST", "/user/repos", 2)).toMatchObject({ own: false, rerun: false });
    expect(parse("POST", "/repos/other/thing/actions/runs/9/rerun")).toMatchObject({
      own: false,
      rerun: false,
    });
  });

  it("routes no write as its own when the task has no project", () => {
    expect(() => parseApiRequest("GET", "/user/repos", null)).not.toThrow();
    expect(parseApiRequest("POST", "/repos/octo/meter/issues", null, 2)).toMatchObject({
      own: false,
    });
  });

  it("refuses traversal, encoded separators, odd characters and ambiguous queries", () => {
    expect(refused("GET", "/repos/octo/meter/../other/pulls")).toContain("..");
    expect(refused("GET", "/repos/octo/meter/contents/a%2fb")).toContain("encoded");
    expect(refused("GET", "/repos/octo/meter//pulls")).toContain("empty");
    expect(refused("GET", "/repos/octo/meter/pulls#x")).toContain("fragment");
    expect(refused("GET", "/repos/octo/meter/pulls?state=open&state=closed")).toContain("repeats");
    expect(refused("GET", "/repos/octo/meter/pulls?per_page=101")).toContain("per_page");
  });

  it("refuses an unknown method, a read with a body and an oversized body", () => {
    expect(refused("TRACE", "/repos/octo/meter/pulls")).toContain("TRACE");
    expect(refused("GET", "/repos/octo/meter/pulls", 5)).toContain("no body");
    expect(refused("POST", "/repos/octo/meter/issues", 256 * 1024 + 1)).toContain("256 KiB");
  });

  it("hands back a next page whenever it stays on the API origin", () => {
    const base = "https://api.github.com";
    const link = (url: string) => `<${url}>; rel="next", <${base}/last>; rel="last"`;
    expect(
      nextPagePath(link(`${base}/repositories/1/pulls?page=2&per_page=100`), base, PROJECT),
    ).toBe("/repositories/1/pulls?page=2&per_page=100");
    expect(nextPagePath(link(`${base}/user/repos?page=2`), base, null)).toBe("/user/repos?page=2");
    expect(nextPagePath(link(`${base}/user/keys?page=2`), base, null)).toBe("/user/keys?page=2");
    expect(nextPagePath(link(`${base}/graphql?page=2`), base, null)).toBeNull();
    expect(nextPagePath(link(`${base}/repos/Octo/Meter/pulls?page=2`), base, PROJECT)).toBe(
      "/repos/Octo/Meter/pulls?page=2",
    );
    expect(
      nextPagePath(link("https://evil.example/repos/Octo/Meter/pulls"), base, PROJECT),
    ).toBeNull();
    expect(nextPagePath(`<${base}/x>; rel="last"`, base, PROJECT)).toBeNull();
    expect(nextPagePath(null, base, PROJECT)).toBeNull();
  });

  it("keeps a GitHub Enterprise Server's next page under its own /api/v3", () => {
    const base = "https://github.corp.example/api/v3";
    const link = (url: string) => `<${url}>; rel="next"`;
    expect(nextPagePath(link(`${base}/user/repos?page=2`), base, null)).toBe("/user/repos?page=2");
    expect(nextPagePath(link(`${base}/repos/Octo/Meter/pulls?page=3`), base, PROJECT)).toBe(
      "/repos/Octo/Meter/pulls?page=3",
    );
    // The same origin outside the API's own path is not a page of it.
    expect(
      nextPagePath(link("https://github.corp.example/user/repos?page=2"), base, null),
    ).toBeNull();
    expect(
      nextPagePath(link("https://github.corp.example/api/v3x/user/repos"), base, null),
    ).toBeNull();
  });
});
