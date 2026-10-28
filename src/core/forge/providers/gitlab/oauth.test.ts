import { join } from "node:path";
import type { ForgeStartProblem, ForgesView } from "@shared/forges";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import { ForgeSignInStore, ForgeSignIns } from "../../signIns";
import { createGitLabServer } from "./signIn";

/**
 * The captain could not start GitLab browser sign-in and saw one generic
 * message whatever GitLab answered (INF-1671). Each answer below is the one
 * GitLab gives a device request (`POST /oauth/authorize_device`): read live
 * from gitlab.com (the 200 and the plain-text 404 for an ID it does not
 * know) or from GitLab's Doorkeeper device patch (a 400 `access_denied`
 * while Device authorization grant is off, `invalid_scope`, a 401
 * `invalid_client`). The view names the reason; the log names the status
 * and code, never the Application ID.
 */

const APPLICATION_ID = "f3c1d2e4b5a6978877665544332211009988776655443322110099887766aabb";

type Reply = { status: number; type: string; text: string } | "unreachable";

const json = (status: number, body: unknown): Reply => ({
  status,
  type: "application/json; charset=utf-8",
  text: JSON.stringify(body),
});

function signIns(reply: Reply) {
  const logged: string[] = [];
  const pushed: ForgesView[] = [];
  const asked: { url: string; body: string }[] = [];
  const service = new ForgeSignIns({
    store: new ForgeSignInStore(join(scratchDir("infinitary-gitlab-oauth-"), "forges")),
    providers: [],
    servers: [
      createGitLabServer({
        apiBaseFor: (host) => `https://${host}/api/v4`,
        fetch: (async (url: string | URL, init?: RequestInit) => {
          asked.push({ url: String(url), body: String(init?.body) });
          if (reply === "unreachable") throw new TypeError("fetch failed");
          return new Response(reply.text, {
            status: reply.status,
            headers: { "Content-Type": reply.type },
          });
        }) as typeof fetch,
      }),
    ],
    projectsOn: () => 0,
    push: (view) => pushed.push(view),
    log: (line) => logged.push(line),
  });
  const start = () =>
    service.signInWithBrowser({
      kind: "gitlab",
      address: "gitlab.com",
      applicationId: APPLICATION_ID,
    });
  return { start, logged, pushed, asked };
}

describe("starting GitLab browser sign-in", () => {
  it("shows the code GitLab issues to an application with Device authorization grant on", async () => {
    const { start, asked, pushed } = signIns(
      json(200, {
        device_code: "GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIySk9eS",
        user_code: "WDJBMJHT",
        verification_uri: "https://gitlab.com/oauth/device",
        verification_uri_complete: "https://gitlab.com/oauth/device?user_code=WDJBMJHT",
        expires_in: 300,
        interval: 5,
      }),
    );
    await expect(start()).resolves.toMatchObject({
      host: "gitlab.com",
      userCode: "WDJBMJHT",
      verificationUri: "https://gitlab.com/oauth/device",
    });
    expect(asked).toEqual([
      {
        url: "https://gitlab.com/oauth/authorize_device",
        body: `client_id=${APPLICATION_ID}&scope=api+write_repository`,
      },
    ]);
    expect(pushed.at(-1)?.ended).toBeNull();
  });

  const refusals: [string, Reply, ForgeStartProblem, string][] = [
    [
      "Device authorization grant is off on the application",
      json(400, {
        error: "access_denied",
        error_description: "The resource owner or authorization server denied the request.",
      }),
      "not-allowed",
      "HTTP 400, access_denied",
    ],
    [
      "the application lacks a scope the app asks for",
      json(400, {
        error: "invalid_scope",
        error_description: "The requested scope is invalid, unknown, or malformed.",
      }),
      "scope",
      "HTTP 400, invalid_scope",
    ],
    [
      "the server does not accept the application",
      json(401, {
        error: "invalid_client",
        error_description:
          "Client authentication failed due to unknown client, no client authentication included, or unsupported authentication method.",
      }),
      "client",
      "HTTP 401, invalid_client",
    ],
    [
      "gitlab.com does not know the Application ID",
      { status: 404, type: "text/plain; charset=utf-8", text: "404 page not found\n" },
      "not-found",
      "HTTP 404",
    ],
    ["the server cannot be reached", "unreachable", "unreachable", "could not be reached"],
    [
      "the server answers with an error page",
      { status: 502, type: "text/html", text: "<html><body>502 Bad Gateway</body></html>" },
      "unreachable",
      "HTTP 502",
    ],
  ];
  for (const [when, reply, problem, logs] of refusals) {
    it(`names why it could not start when ${when}`, async () => {
      const { start, logged, pushed } = signIns(reply);
      await expect(start()).rejects.toThrow();
      expect(pushed.at(-1)?.ended).toEqual({ host: "gitlab.com", end: "failed", problem });
      const line = logged.find((entry) => entry.includes("could not start"));
      expect(line).toContain(`${problem}: `);
      expect(line).toContain(logs);
      expect(logged.join("\n")).not.toContain(APPLICATION_ID);
    });
  }
});
