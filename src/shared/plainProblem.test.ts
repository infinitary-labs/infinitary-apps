import { describe, expect, it } from "vitest";
import {
  isRunawayProviderError,
  PLAIN_PROBLEM_FALLBACK,
  plainProblem,
  typedFailureOf,
} from "./plainProblem";

describe("isRunawayProviderError", () => {
  it("matches the grok thinking-runaway class and not ordinary faults", () => {
    expect(isRunawayProviderError("Response incomplete: max_time_limit")).toBe(true);
    expect(isRunawayProviderError("Grok grok-4.6: Response incomplete: max_time_limit")).toBe(true);
    expect(isRunawayProviderError("Error Code null: Internal error during token generation")).toBe(
      true,
    );
    expect(isRunawayProviderError("Turn timed out after 8 minutes")).toBe(true);
    expect(isRunawayProviderError("Request timed out after 300 seconds")).toBe(true);
    expect(isRunawayProviderError("Connection error.")).toBe(false);
    expect(isRunawayProviderError("upstream 529")).toBe(false);
  });
});

describe("plainProblem", () => {
  it("says what happened and what to do for each known error shape", () => {
    const cases: Array<[string, string]> = [
      [
        '401: {"message":"Incorrect API key provided","code":"invalid_api_key"}',
        "the provider did not accept your sign-in - sign in again",
      ],
      ["No API key found for openai", "the provider did not accept your sign-in - sign in again"],
      [
        "No signed-in model can serve this turn",
        "the provider did not accept your sign-in - sign in again",
      ],
      [
        "Response incomplete: max_time_limit",
        "the model ran out of time on its answer - try again",
      ],
      [
        "429: You exceeded your current quota, please check your plan",
        "your plan's allowance ran out - it comes back when it resets",
      ],
      ["429 Too Many Requests", "the provider asked to slow down - try again shortly"],
      ["openai (429): rate_limit_exceeded", "the provider asked to slow down - try again shortly"],
      [
        "400: This model's maximum context length is 128000 tokens",
        "the conversation grew too long for the model - try again",
      ],
      ["Connection error.", "could not reach the provider - try again"],
      [
        "request to https://api.x.ai failed: getaddrinfo ENOTFOUND api.x.ai",
        "could not reach the provider - try again",
      ],
      ["upstream 529", "the provider had a problem on its side - try again"],
      ['503: {"error":"overloaded"}', "the provider had a problem on its side - try again"],
      ["spawn claude ENOENT", "something it needed is missing on this computer"],
      ["AbortError: This operation was aborted", "it was stopped before it finished"],
    ];
    for (const [raw, line] of cases) expect(plainProblem(raw), raw).toBe(line);
  });

  it("says what a git or GitHub failure means, keyed on the words git and gh print", () => {
    const signIn = "the project's host did not accept the sign-in on this computer";
    const missing = "the project could not be found where it lives";
    const conflicts =
      "it conflicts with newer work in the project - its crewmate needs to bring it up to date";
    const unreachable = "could not reach the project's host - try again";
    const cases: Array<[string, string]> = [
      [
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        signIn,
      ],
      [
        "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/o/r.git/'",
        signIn,
      ],
      [
        "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
        signIn,
      ],
      ["To get started with GitHub CLI, please run:  gh auth login", signIn],
      ["HTTP 401: Bad credentials (https://api.github.com/graphql)", signIn],
      [
        "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found",
        missing,
      ],
      ["GraphQL: Could not resolve to a Repository with the name 'o/r'. (repository)", missing],
      [
        "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
        unreachable,
      ],
      [
        "fatal: unable to access 'https://github.com/o/r.git/': Failed to connect to github.com port 443 after 3 ms",
        unreachable,
      ],
      [
        "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com",
        unreachable,
      ],
      ["spawn gh ENOENT", "something it needed is missing on this computer"],
      // The app's own sign-in and the REST forge's words (git integration PR 1.2).
      [
        "Not signed in to GitHub (github.com)",
        "the app is not signed in where the project lives - sign in under Settings, Projects, or keep the project on this computer",
      ],
      [
        "GitHub answered 401 to PUT /repos/o/r/pulls/7/merge: Bad credentials",
        "the project's host did not accept the sign-in on this computer - sign in again under Settings, Projects",
      ],
      [
        "GitHub answered 403 to POST /repos/o/r/pulls: Resource not accessible by integration",
        "the project's host did not allow it - ask the project's owner for access",
      ],
      ["GitHub answered 404 to GET /repos/o/r", missing],
      [
        "GitHub answered 405 to PUT /repos/kunchenguid/firstmate-3000/pulls/335/merge: Pull Request has merge conflicts",
        conflicts,
      ],
      [
        "GitHub answered 405 to PUT /repos/o/r/pulls/7/merge: Pull Request is not mergeable",
        conflicts,
      ],
      [
        "GitHub answered 409 to PUT /repos/o/r/pulls/7/merge: Pull Request has merge conflicts",
        conflicts,
      ],
      // A 409 for a moved head is not a conflict.
      [
        "GitHub answered 409 to PUT /repos/o/r/pulls/7/merge: Head branch was modified. Review and try the merge again.",
        PLAIN_PROBLEM_FALLBACK,
      ],
      ["GitHub answered 503 to GET /repos/o/r/pulls", unreachable],
      ["could not reach GitHub: fetch failed", unreachable],
      // GitLab's answers, on gitlab.com and a self-hosted server, as its forge words them.
      [
        "GitLab answered 403 to POST /projects/g%2Fs%2Fapp/merge_requests: 403 Forbidden",
        "the project's host did not allow it - ask the project's owner for access",
      ],
      ["gitlab.example.com answered 404 to GET /projects/g%2Fapp", missing],
      [
        "GitLab answered 422 to PUT /projects/g%2Fapp/merge_requests/4/merge: Branch cannot be merged",
        conflicts,
      ],
      [
        "gitlab.example.com answered 406 to PUT /projects/g%2Fapp/merge_requests/4/merge: Branch cannot be merged",
        conflicts,
      ],
      // A 409 for a moved head is not a conflict on GitLab either.
      [
        "GitLab answered 409 to PUT /projects/g%2Fapp/merge_requests/4/merge: SHA does not match HEAD of source branch",
        PLAIN_PROBLEM_FALLBACK,
      ],
      ["gitlab.example.com answered 502 to GET /projects/g%2Fapp/pipelines", unreachable],
      ["could not reach gitlab.example.com: fetch failed", unreachable],
      [
        "The repository has uncommitted changes; commit or stash them first.",
        "your project has edits that are not committed yet - commit or set them aside first",
      ],
      [
        "The repository is on a detached HEAD; check out a branch first.",
        "your project is not on a named branch - switch to one first",
      ],
      [
        "Merging fm/task-1 into main hit a conflict; resolve it manually. CONFLICT (content)",
        "could not bring it up to date - the work and your project changed the same place",
      ],
    ];
    for (const [raw, line] of cases) expect(plainProblem(raw), raw).toBe(line);
  });

  it("never reads a provider's own failure as the project's host", () => {
    expect(plainProblem('Authentication failed for "openai"')).toBe(
      "the provider did not accept your sign-in - sign in again",
    );
    expect(plainProblem("request to https://api.x.ai failed: getaddrinfo ENOTFOUND api.x.ai")).toBe(
      "could not reach the provider - try again",
    );
  });

  it("falls back to a plain line instead of passing unknown text through", () => {
    expect(plainProblem("TypeError: Cannot read properties of undefined (reading 'x')")).toBe(
      PLAIN_PROBLEM_FALLBACK,
    );
    expect(plainProblem("boom")).toBe(PLAIN_PROBLEM_FALLBACK);
    expect(plainProblem("")).toBe(PLAIN_PROBLEM_FALLBACK);
    expect(plainProblem(undefined)).toBe(PLAIN_PROBLEM_FALLBACK);
  });

  it("never reads a status number out of prose as a provider fault", () => {
    expect(plainProblem("the file has 500 lines and 429 of them are blank")).toBe(
      PLAIN_PROBLEM_FALLBACK,
    );
  });
});

describe("plainProblem for a typed failure", () => {
  const SIGN_IN = "the provider did not accept your sign-in - sign in again";
  const ALLOWANCE = "your plan's allowance ran out - it comes back when it resets";

  it("reads the cut-off class, never the words beside it", () => {
    // The words Claude's client really writes for each class.
    expect(
      plainProblem("Not logged in · Please run /login", { cutOff: { class: "signed_out" } }),
    ).toBe(SIGN_IN);
    expect(
      plainProblem("You've hit your limit · resets 3pm", {
        cutOff: { class: "no_headroom", resetsAt: 1 },
      }),
    ).toBe(ALLOWANCE);
    // A refusal has no sentence of its own yet: the plain fallback.
    expect(plainProblem("Credit balance is too low", { cutOff: { class: "refused" } })).toBe(
      PLAIN_PROBLEM_FALLBACK,
    );
  });

  it("never reads a sign-in, an allowance or a slow-down out of a typed failure's words", () => {
    expect(plainProblem("API Error: 401 Unauthorized", {})).toBe(PLAIN_PROBLEM_FALLBACK);
    expect(plainProblem("Server is temporarily limiting requests (not your usage limit)", {})).toBe(
      PLAIN_PROBLEM_FALLBACK,
    );
    expect(plainProblem("API Error: 429 rate_limit_error", {})).toBe(PLAIN_PROBLEM_FALLBACK);
    // The same words from a prose backend still read as they always did.
    expect(plainProblem("API Error: 401 Unauthorized")).toBe(SIGN_IN);
    // Rules that name no class still apply to a typed failure.
    expect(plainProblem("API Error: 529 overloaded", {})).toBe(
      "the provider had a problem on its side - try again",
    );
  });

  it("reads back what a timeline event recorded", () => {
    expect(typedFailureOf({ error: "x", fatal: false })).toBeUndefined();
    expect(typedFailureOf(null)).toBeUndefined();
    expect(typedFailureOf({ error: "x", failureSignals: "typed" })).toEqual({});
    expect(
      typedFailureOf({
        error: "x",
        failureSignals: "typed",
        cutOff: { class: "no_headroom", resetsAt: 5 },
      }),
    ).toEqual({ cutOff: { class: "no_headroom", resetsAt: 5 } });
    // A class this build does not know is no class, never a guess.
    expect(
      typedFailureOf({ error: "x", failureSignals: "typed", cutOff: { class: "gone" } }),
    ).toEqual({});
  });
});
