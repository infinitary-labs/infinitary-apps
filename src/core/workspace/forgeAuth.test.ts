import { describe, expect, it } from "vitest";
import { forgeAuthRequired } from "./forgeAuth";

describe("forgeAuthRequired", () => {
  it("classifies the known GitHub askpass username refusal", () => {
    expect(
      forgeAuthRequired("https://github.com/acme/project.git", {
        stderr:
          "error: unable to read askpass response from helper\nfatal: could not read Username for 'https://github.com': terminal prompts disabled",
      }),
    ).toMatchObject({ host: "github.com", name: "ForgeAuthRequiredError" });
  });

  it("classifies GitHub's explicit HTTPS credential rejection", () => {
    expect(
      forgeAuthRequired("git@github.com:acme/project.git", {
        stderr: "fatal: Authentication failed for 'https://github.com/acme/project.git/'",
      }),
    ).toBeInstanceOf(Error);
  });

  it.each([
    [
      "GitHub network failure",
      "https://github.com/acme/project.git",
      "Could not resolve host: github.com",
    ],
    [
      "other host auth failure",
      "https://bitbucket.org/acme/project.git",
      "Authentication failed for 'https://bitbucket.org/acme/project.git/'",
    ],
    ["GitHub SSH refusal", "git@github.com:acme/project.git", "Permission denied (publickey)."],
    [
      "unstructured username text",
      "https://github.com/acme/project.git",
      "could not read Username for 'https://github.com'; askpass could not complete",
    ],
  ])("does not classify %s as app GitHub sign-in", (_name, origin, stderr) => {
    expect(forgeAuthRequired(origin, { stderr })).toBeUndefined();
  });

  it.each(["gitlab.com", "gitlab.example.com"])(
    "classifies GitLab's explicit refusal for %s with a host-keyed wait",
    (host) => {
      const error = {
        stderr: `fatal: Authentication failed for 'https://${host}/group/subgroup/app.git/'`,
      };
      expect(
        forgeAuthRequired(`https://${host}/group/subgroup/app.git`, error, [
          { host, kind: "gitlab" },
        ]),
      ).toMatchObject({ host });
      // A work computer offering no GitLab sign-in cannot recover through that gate.
      expect(forgeAuthRequired(`https://${host}/group/subgroup/app.git`, error)).toBeUndefined();
      expect(
        forgeAuthRequired(
          `git@${host}:group/subgroup/app.git`,
          { stderr: "Permission denied (publickey)." },
          [{ host, kind: "gitlab" }],
        ),
      ).toBeUndefined();
    },
  );

  // INF-5192: a refused Bitbucket fetch waits for the app's Bitbucket sign-in.
  it("classifies Bitbucket's explicit refusal where the app offers its sign-in", () => {
    const origin = "https://bitbucket.org/acme/project.git";
    const error = {
      stderr: "fatal: Authentication failed for 'https://bitbucket.org/acme/project.git/'",
    };
    expect(
      forgeAuthRequired(origin, error, [{ host: "bitbucket.org", kind: "bitbucket" }]),
    ).toMatchObject({ host: "bitbucket.org", place: "Bitbucket" });
    // A computer offering no Bitbucket sign-in keeps it a plain failure.
    expect(forgeAuthRequired(origin, error)).toBeUndefined();
    expect(
      forgeAuthRequired(
        "git@bitbucket.org:acme/project.git",
        {
          stderr: "Permission denied (publickey).",
        },
        [{ host: "bitbucket.org", kind: "bitbucket" }],
      ),
    ).toBeUndefined();
  });

  it("classifies the same refusal on a host on the person's own server it knows, keyed by that host", () => {
    const refused = {
      stderr:
        "error: unable to read askpass response from helper\nfatal: could not read Username for 'https://github.corp.example': terminal prompts disabled",
    };
    const origin = "https://github.corp.example/acme/project.git";
    const known = [{ host: "github.corp.example", kind: "github" as const }];
    expect(forgeAuthRequired(origin, refused, known)).toMatchObject({
      host: "github.corp.example",
      place: "github.corp.example",
      message: "github.corp.example requires sign-in to fetch this project.",
    });
    // Unknown to the app, it is a plain host's failure; github.com's words never match it.
    expect(forgeAuthRequired(origin, refused)).toBeUndefined();
    expect(
      forgeAuthRequired(
        origin,
        { stderr: "fatal: Authentication failed for 'https://github.com/acme/project.git/'" },
        known,
      ),
    ).toBeUndefined();
    expect(
      forgeAuthRequired("https://octo.ghe.com/acme/project.git", {
        stderr: "fatal: Authentication failed for 'https://octo.ghe.com/acme/project.git/'",
      }),
    ).toMatchObject({ host: "octo.ghe.com" });
  });
});
