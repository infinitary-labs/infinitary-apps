import { describe, expect, it } from "vitest";
import { ForgeError, type ForgeProject } from "./forge";
import { exactName, type RemoteHost, remoteProjectsText } from "./projects";

/**
 * locate_project's remote half (git integration PR 1.2): the projects the
 * captain has where they live, from the app's own sign-in, and the
 * sign-in's way when there is none - only when nothing was found on this
 * Mac, because a project found here never needs a host.
 */

const PROJECTS: ForgeProject[] = [
  {
    fullName: "octo/meterlab",
    cloneUrl: "https://github.com/octo/meterlab.git",
    url: "https://github.com/octo/meterlab",
    updatedAt: "2026-09-20T10:00:00Z",
    private: true,
  },
  {
    fullName: "octo/website",
    cloneUrl: "https://github.com/octo/website.git",
    url: null,
    updatedAt: null,
    private: false,
  },
];

function github(overrides: Partial<RemoteHost> = {}): RemoteHost {
  return {
    host: "github.com",
    name: "GitHub",
    signedIn: true,
    login: "octo",
    list: async () => ({ projects: PROJECTS, complete: true }),
    ...overrides,
  };
}

describe("remoteProjectsText", () => {
  it("keeps nested groups in a GitLab address and exact lookup", async () => {
    const project = PROJECTS[0];
    if (!project) throw new Error("Project fixture is missing");
    const find = async (fullName: string) =>
      fullName === "group/subgroup/app"
        ? {
            ...project,
            fullName,
            cloneUrl: `https://gitlab.com/${fullName}.git`,
            url: `https://gitlab.com/${fullName}`,
          }
        : null;
    const text = await remoteProjectsText({
      name: "https://gitlab.com/group/subgroup/app/-/tree/main",
      foundLocally: false,
      hosts: [github({ host: "gitlab.com", name: "GitLab", find, nestedNamespace: true })],
    });
    expect(text).toContain("- group/subgroup/app");
    expect(exactName("git@gitlab.com:group/subgroup/app.git", true)).toBe("group/subgroup/app");
    expect(exactName("group/subgroup/actions/app", true)).toBe("group/subgroup/actions/app");
  });
  it("lists what matches the name, with what app_change project-setup clone takes", async () => {
    const text = await remoteProjectsText({
      name: "meter",
      foundLocally: false,
      hosts: [github()],
    });
    expect(text).toBe(
      [
        "On GitHub, signed in as octo (searched 2 projects):",
        "- octo/meterlab (updated 2026-09-20) | private | clone origin https://github.com/octo/meterlab.git",
      ].join("\n"),
    );
  });

  it("lists the newest when nothing matches, so the picker card is still one call", async () => {
    const text = await remoteProjectsText({ name: "zzz", foundLocally: false, hosts: [github()] });
    expect(text.split("\n")).toEqual([
      'On GitHub, signed in as octo (searched 2 projects): nothing named like "zzz"; the newest are:',
      "- octo/meterlab (updated 2026-09-20) | private | clone origin https://github.com/octo/meterlab.git",
      "- octo/website | clone origin https://github.com/octo/website.git",
    ]);
  });

  it("matches loosely: case, spaces, dashes and underscores do not tell names apart", async () => {
    for (const written of ["Meter Lab", "meter_lab", "meter-lab", "METERLAB", "octo/meterlab"]) {
      const text = await remoteProjectsText({
        name: written,
        foundLocally: false,
        hosts: [github()],
      });
      expect(text, written).toContain("- octo/meterlab");
      expect(text, written).not.toContain("nothing named like");
    }
  });

  it("finds a pasted address, and an exact repo past the listing, by its own lookup", async () => {
    const past: ForgeProject = {
      fullName: "acme/old-repo",
      cloneUrl: "https://github.com/acme/old-repo.git",
      url: null,
      updatedAt: null,
      private: true,
    };
    const asked: string[] = [];
    const host = github({
      find: async (fullName) => {
        asked.push(fullName);
        return fullName === "acme/old-repo" ? past : null;
      },
    });
    for (const written of [
      "https://github.com/acme/old-repo",
      "https://github.com/acme/old-repo.git",
      "git@github.com:acme/old-repo.git",
      "github.com/acme/old-repo/pull/3",
      "acme/old-repo",
    ]) {
      const text = await remoteProjectsText({ name: written, foundLocally: false, hosts: [host] });
      expect(text.split("\n")[1], written).toContain("- acme/old-repo | private");
    }
    expect(asked).toEqual(Array(5).fill("acme/old-repo"));
    const miss = await remoteProjectsText({
      name: "acme/nope",
      foundLocally: false,
      hosts: [host],
    });
    expect(miss).toContain("and no acme/nope the sign-in can see");
  });

  it("says when the listing was cut short, so a miss is not read as proof", async () => {
    const text = await remoteProjectsText({
      name: "zzz",
      foundLocally: false,
      hosts: [github({ list: async () => ({ projects: PROJECTS, complete: false }) })],
    });
    expect(text).toContain("searched 2 projects, the newest only: older ones were not read");
  });

  it("reads a written name as an owner/name only when it is one", () => {
    expect(exactName("octo/meter")).toBe("octo/meter");
    expect(exactName("https://github.com/octo/meter.git")).toBe("octo/meter");
    expect(exactName("meter lab")).toBeNull();
    expect(exactName("meterlab")).toBeNull();
    expect(exactName("octo/meter/extra/things")).toBeNull();
  });

  it("offers the sign-in only when nothing was found on this Mac", async () => {
    const signedOut = github({ signedIn: false, login: null });
    expect(
      await remoteProjectsText({ name: "meter", foundLocally: true, hosts: [signedOut] }),
    ).toBe("");
    const text = await remoteProjectsText({
      name: "meter",
      foundLocally: false,
      hosts: [signedOut],
    });
    expect(text.split("\n")[0]).toBe(
      "Not signed in to GitHub (github.com): with the captain's GitHub sign-in, the projects there are listed here too.",
    );
    // The one way: there is no project yet to keep on this Mac.
    expect(text).toContain('"target": "projects"');
    expect(text).not.toContain("configure_repo");
  });

  it("says the sign-in lapsed when the host refuses it, and anything else as it happened", async () => {
    const lapsed = await remoteProjectsText({
      name: "x",
      foundLocally: false,
      hosts: [
        github({
          list: async () => {
            throw new ForgeError("sign-in", "GitHub answered 401 to GET /user/repos");
          },
        }),
      ],
    });
    expect(lapsed).toContain("GitHub no longer accepts the sign-in");
    const down = await remoteProjectsText({
      name: "x",
      foundLocally: true,
      hosts: [
        github({
          list: async () => {
            throw new ForgeError("transient", "could not reach GitHub: ECONNRESET");
          },
        }),
      ],
    });
    expect(down).toBe("Could not list the projects on GitHub: could not reach GitHub: ECONNRESET");
  });
});
