import { describe, expect, it } from "vitest";
import { ForgeError } from "../../forge";
import { nextGitLabPagePath, parseGitLabApiRequest } from "./api";

const PROJECT = "Group/Sub/Field-Notes";
const OWN = encodeURIComponent(PROJECT);
const parse = (method: string, path: string, bytes = 0) =>
  parseGitLabApiRequest(method, path, PROJECT, bytes);
const refused = (method: string, path: string, bytes = 0) => {
  try {
    parse(method, path, bytes);
  } catch (caught) {
    expect(caught).toBeInstanceOf(ForgeError);
    return (caught as ForgeError).message;
  }
  throw new Error(`${method} ${path} was not refused`);
};

describe("GitLab's gateway policy", () => {
  it("takes the task's project by its URL-encoded path, in any case, and spells it one way", () => {
    expect(parse("get", "/projects/group%2Fsub%2Ffield-notes/merge_requests?state=opened")).toEqual(
      {
        method: "GET",
        write: false,
        path: `/projects/${OWN}/merge_requests?state=opened`,
        rest: "merge_requests",
        rerun: false,
        own: true,
      },
    );
    expect(parse("POST", "/projects/group%2fsub%2fField-Notes/merge_requests/4/notes", 12)).toEqual(
      {
        method: "POST",
        write: true,
        path: `/projects/${OWN}/merge_requests/4/notes`,
        rest: "merge_requests/4/notes",
        rerun: false,
        own: true,
      },
    );
  });

  it("lets a read reach any project the key may read, the lists, public group and people reads, and search", () => {
    for (const path of [
      "/projects/acme%2Fsite/issues?state=opened&per_page=100",
      "/projects/42/pipelines?sha=abc",
      "/projects/acme%2Fsite/repository/files/src%2Fmain.rb/raw?ref=main",
      "/projects/acme%2Fsite/repository/branches/feature%2Fnotes",
      "/projects?membership=true&search=notes",
      "/groups?min_access_level=10",
      "/groups/acme",
      "/groups/acme%2Ftools/projects",
      "/groups/acme/subgroups",
      "/groups/acme/descendant_groups",
      "/groups/acme/merge_requests?state=opened",
      "/groups/acme/issues",
      "/users/octo",
      "/users/octo/projects",
      "/merge_requests?scope=created_by_me&state=opened",
      "/issues?scope=assigned_to_me",
      "/search?scope=projects&search=notes",
    ]) {
      expect(parse("GET", path)).toMatchObject({ write: false, path });
    }
  });

  it("lets a read reach the key's own account, groups and the instance, and routes every write there as not the project's", () => {
    for (const path of [
      "/user",
      "/user/keys",
      "/user/emails",
      "/user/gpg_keys",
      "/personal_access_tokens",
      "/personal_access_tokens/self",
      "/users",
      "/users/octo/keys",
      "/groups/acme/members",
      "/groups/acme/variables",
      "/groups/acme/hooks",
      "/groups/acme/access_tokens",
      "/application/settings",
      "/admin/ci/variables",
      "/runners/all",
      "/hooks",
    ]) {
      for (const method of ["GET", "HEAD"]) {
        expect(parse(method, path)).toMatchObject({ write: false, path });
      }
      for (const method of ["POST", "PUT", "DELETE"]) {
        expect(parse(method, path)).toMatchObject({ write: true, own: false, path });
      }
    }
    for (const method of ["GET", "POST"]) expect(refused(method, "/graphql")).toContain("GraphQL");
  });

  it("takes a write as its own only under the task's project named by its path, and never deletes a project", () => {
    expect(parse("POST", "/projects/acme%2Fsite/issues", 2)).toMatchObject({ own: false });
    expect(parse("PUT", "/projects/42/jobs/7/retry")).toMatchObject({ own: false });
    expect(parse("POST", "/projects/42/jobs/7/retry")).toMatchObject({ own: false, rerun: false });
    expect(parse("POST", "/groups/acme/projects", 2)).toMatchObject({ own: false });
    expect(refused("DELETE", `/projects/${OWN}`)).toContain("Deleting the project");
    expect(refused("DELETE", "/projects/acme%2Fsite")).toContain("Deleting the project");
    expect(refused("DELETE", "/projects/42")).toContain("Deleting the project");
    expect(refused("DELETE", `/projects/${OWN}/`)).toContain("empty");
    for (const [method, rest] of [
      ["PUT", ""],
      ["POST", "pipeline?ref=main"],
      ["POST", "pipelines/9/cancel"],
      ["PUT", "repository/files/.gitlab-ci.yml"],
      ["POST", "variables"],
      ["PUT", "members/7"],
      ["DELETE", "repository/branches/feature%2Fnotes"],
      ["POST", "fork"],
    ]) {
      const raw = `/projects/${OWN}${rest ? `/${rest}` : ""}`;
      expect(parse(method as string, raw)).toMatchObject({
        method,
        write: true,
        own: true,
        path: raw,
      });
    }
    expect(() => parseGitLabApiRequest("GET", "/projects/acme%2Fsite", null)).not.toThrow();
    expect(parseGitLabApiRequest("POST", `/projects/${OWN}/issues`, null, 2)).toMatchObject({
      own: false,
    });
  });

  it("recognizes a job or pipeline retry and a manual job's start as a rerun, and nothing else", () => {
    for (const rest of ["jobs/7/retry", "jobs/7/play", "pipelines/9/retry"]) {
      expect(parse("POST", `/projects/${OWN}/${rest}`).rerun).toBe(true);
    }
    expect(parse("POST", `/projects/${OWN}/pipelines/9/cancel`).rerun).toBe(false);
    expect(parse("GET", `/projects/${OWN}/jobs/7/retry`).rerun).toBe(false);
  });

  it("refuses traversal hidden in an encoded path, other encodings, odd characters and ambiguous queries", () => {
    expect(refused("GET", "/projects/acme%2F..%2F..%2Fuser/keys")).toContain("..");
    expect(refused("GET", "/projects/acme%2F%2Fsite")).toContain("empty");
    expect(refused("GET", "/projects/acme%2Fsite/../../user")).toContain("..");
    for (const path of [
      "/projects/acme%2E%2E/issues",
      "/projects/acme%5Csite",
      "/projects/acme%00",
      "/projects/acme%252Fsite",
    ]) {
      expect(refused("GET", path)).toContain("encoded");
    }
    expect(refused("GET", "/projects/acme%2Fsite/issues#x")).toContain("fragment");
    expect(refused("GET", "/projects?search=a&search=b")).toContain("repeats");
    expect(refused("GET", "/projects?per_page=101")).toContain("per_page");
    expect(refused("GET", "https://gitlab.com/api/v4/projects")).toContain("relative");
    expect(refused("GET", "/projects", 5)).toContain("no body");
  });

  it("hands back a next page whenever it stays on the server's own /api/v4", () => {
    const base = "https://gitlab.example.com/api/v4";
    const link = (url: string) => `<${url}>; rel="next", <${base}/last>; rel="last"`;
    expect(
      nextGitLabPagePath(
        link(`${base}/projects/group%2Fsub%2Ffield-notes/merge_requests?id=x&page=2&per_page=20`),
        base,
        PROJECT,
      ),
    ).toBe(`/projects/${OWN}/merge_requests?id=x&page=2&per_page=20`);
    expect(nextGitLabPagePath(link(`${base}/projects?page=2`), base, null)).toBe(
      "/projects?page=2",
    );
    expect(nextGitLabPagePath(link(`${base}/user/keys?page=2`), base, null)).toBe(
      "/user/keys?page=2",
    );
    expect(nextGitLabPagePath(link("https://gitlab.example.com/projects?page=2"), base, null)).toBe(
      null,
    );
    expect(nextGitLabPagePath(link("https://elsewhere.example/api/v4/projects"), base, null)).toBe(
      null,
    );
    expect(nextGitLabPagePath(null, base, PROJECT)).toBeNull();
  });
});
