import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BITBUCKET, GITHUB_ENTERPRISE, GITLAB } from "@shared/forges";
import { describe, expect, it, vi } from "vitest";
import {
  BITBUCKET_KEY,
  ENTERPRISE_KEY,
  GITHUB_CLI_SIGN_IN,
  GITHUB_SIGN_IN,
  GITLAB_APPLICATION,
  GITLAB_SIGN_IN,
  joined,
  savedText,
  standInGitHub,
  standInServers,
} from "../../../tests/helpers/helperSignIns";
import { ForgeSignInStore, type GitHubCli } from "../forge";
import { hostEnv } from "../hostEnv";

describe("a computer that runs work signs in to its own subscriptions from its home", () => {
  it("signs in to GitHub with a code read at home, which the computer finishes and its git uses", async () => {
    const github = standInGitHub();
    const askpass = join(__dirname, "../../../resources/git-askpass");
    const world = await joined({ gitAskpass: askpass });
    world.signIns.read();
    await expect
      .poll(() => world.group()?.signIns?.forges)
      .toEqual({
        signIns: [],
        hosts: [{ host: "github.com", name: "GitHub" }],
        servers: [GITHUB_ENTERPRISE, GITLAB, BITBUCKET],
      });

    const { signInId } = await world.signIns.startForge(world.deviceId, "github.com");
    await expect
      .poll(() => world.steps(signInId).find((step) => step.kind === "notice"))
      .toMatchObject({
        notice: {
          kind: "device_code",
          userCode: "WDJB-0042",
          url: "https://github.com/login/device",
        },
      });
    // Nobody types anything: the computer asks GitHub until it says yes.
    expect(await world.ended(signInId)).toEqual({ kind: "ended", outcome: "signed-in" });
    await expect
      .poll(() => world.group()?.signIns?.forges?.signIns)
      .toEqual([
        {
          host: "github.com",
          name: "GitHub",
          login: "octo-mini",
          state: "ok",
          since: expect.any(Number),
        },
      ]);
    expect(world.events).toContainEqual(
      expect.objectContaining({ type: "device_signed_in", who: "Builder", provider: "GitHub" }),
    );
    expect(github.asked).toContainEqual({
      url: "https://api.github.com/user",
      auth: `Bearer ${GITHUB_SIGN_IN}`,
    });

    // The sign-in is in the computer's own store, which its git's helper reads.
    const forges = join(world.dataDir, "forges");
    expect(new ForgeSignInStore(forges).read("github.com")).toMatchObject({
      token: GITHUB_SIGN_IN,
      login: "octo-mini",
    });
    expect(statSync(join(forges, "github.com", "sign-in.json")).mode & 0o777).toBe(0o600);
    expect(hostEnv()).toMatchObject({
      GIT_ASKPASS: askpass,
      INFINITARY_GIT_SIGNIN_DIR: forges,
      GIT_TERMINAL_PROMPT: "0",
    });
    // Nothing the home said, pushed or saved holds it.
    expect(JSON.stringify([world.emitted, world.events, world.signIns.view()])).not.toContain(
      GITHUB_SIGN_IN,
    );
    expect(savedText(world.homeDir).filter(({ text }) => text.includes(GITHUB_SIGN_IN))).toEqual(
      [],
    );

    // Its health is read there: GitHub refusing it is a sign-in again at home.
    github.refuse();
    await (await world.held()).forges.checkHealth();
    await expect.poll(() => world.group()?.signIns?.forges?.signIns[0]?.state).toBe("needs_reauth");

    await world.signIns.signOutForge(world.deviceId, "github.com");
    await expect.poll(() => world.group()?.signIns?.forges?.signIns).toEqual([]);
    expect(existsSync(join(forges, "github.com"))).toBe(false);
  });

  // The captain's ask (INF-3145): a separate computer's own GitHub sign-in
  // offers what this Mac's does, the GitHub CLI sign-in already on it.
  it("signs a computer in to GitHub through its own GitHub CLI, keeping only the way", async () => {
    const github = standInGitHub();
    // GitHub CLI there, as `gh auth token --hostname <host>` answers: signed in to github.com alone.
    const gh = "/opt/homebrew/bin/gh";
    let cliSignedIn = true;
    const asked: string[] = [];
    const githubCli: GitHubCli = {
      find: () => gh,
      token: async (program, host) => {
        asked.push(`${program} ${host}`);
        return cliSignedIn && host === "github.com"
          ? { token: GITHUB_CLI_SIGN_IN }
          : { problem: "none", reason: `GitHub CLI holds no sign-in for ${host}` };
      },
    };
    const world = await joined({ githubCli });
    world.signIns.read();
    await expect
      .poll(() => world.group()?.signIns?.forges)
      .toEqual({
        signIns: [],
        hosts: [{ host: "github.com", name: "GitHub" }],
        githubCli: true,
        servers: [GITHUB_ENTERPRISE, GITLAB, BITBUCKET],
      });

    expect(await world.signIns.forgeWithCli(world.deviceId, "github.com")).toEqual({
      ok: true,
      host: "github.com",
    });
    await expect
      .poll(() => world.group()?.signIns?.forges?.signIns)
      .toEqual([
        {
          host: "github.com",
          name: "GitHub",
          login: "octo-mini",
          state: "ok",
          since: expect.any(Number),
          way: "cli",
        },
      ]);
    expect(github.asked).toContainEqual({
      url: "https://api.github.com/user",
      auth: `Bearer ${GITHUB_CLI_SIGN_IN}`,
    });
    const forges = join(world.dataDir, "forges");
    const file = readFileSync(join(forges, "github.com", "sign-in.json"), "utf8");
    expect(JSON.parse(file)).toMatchObject({ way: "cli", program: gh, login: "octo-mini" });
    expect(file).not.toContain(GITHUB_CLI_SIGN_IN);
    // Only the program the store names was asked, for github.com; its git's helper reads the same file.
    expect(new Set(asked)).toEqual(new Set([`${gh} github.com`]));
    // Nothing the home said, pushed or saved holds it, nor the computer's log.
    expect(
      JSON.stringify([world.emitted, world.events, world.signIns.view(), world.logs]),
    ).not.toContain(GITHUB_CLI_SIGN_IN);
    expect(
      savedText(world.homeDir).filter(({ text }) => text.includes(GITHUB_CLI_SIGN_IN)),
    ).toEqual([]);

    // A host GitHub CLI holds no sign-in for is not kept, and says why.
    await world.signIns.signOutForge(world.deviceId, "github.com");
    await expect.poll(() => world.group()?.signIns?.forges?.signIns).toEqual([]);
    cliSignedIn = false;
    expect(await world.signIns.forgeWithCli(world.deviceId, "github.com")).toEqual({
      ok: false,
      problem: "none",
      host: "github.com",
    });
    expect(existsSync(join(forges, "github.com"))).toBe(false);
  });

  // INF-4280's audit item 7: a computer signs in to GitHub Enterprise and
  // GitLab from home, not github.com alone.
  it("signs a computer in to GitHub Enterprise with a key typed at home, which it keeps and its git answers that host with", async () => {
    const servers = standInServers();
    const askpass = join(__dirname, "../../../resources/git-askpass");
    const world = await joined({ gitAskpass: askpass });
    world.signIns.read();
    await expect
      .poll(() => world.group()?.signIns?.forges?.servers)
      .toEqual([GITHUB_ENTERPRISE, GITLAB, BITBUCKET]);

    // A key the server does not answer for is not kept there.
    expect(
      await world.signIns.forgeWithKey(world.deviceId, {
        kind: "github",
        address: "https://github.example.com/acme/api",
        key: "ghp_standin_revoked_0042",
      }),
    ).toEqual({ ok: false, problem: "refused", host: "github.example.com" });
    expect(existsSync(join(world.dataDir, "forges", "github.example.com"))).toBe(false);

    expect(
      await world.signIns.forgeWithKey(world.deviceId, {
        kind: "github",
        address: "https://github.example.com/acme/api",
        key: ENTERPRISE_KEY,
      }),
    ).toEqual({ ok: true, host: "github.example.com" });
    // Its row is the host's own address, signed in as who the server says.
    expect(world.group()?.signIns?.forges?.signIns).toEqual([
      expect.objectContaining({
        host: "github.example.com",
        name: "github.example.com",
        login: "mona",
        state: "ok",
        server: GITHUB_ENTERPRISE,
      }),
    ]);
    expect(world.group()?.signIns?.forges?.hosts).toContainEqual({
      host: "github.example.com",
      name: "github.example.com",
      server: GITHUB_ENTERPRISE,
    });

    // The key is in the computer's own store, which its git answers that host from alone.
    const forges = join(world.dataDir, "forges");
    expect(new ForgeSignInStore(forges).read("github.example.com")).toMatchObject({
      token: ENTERPRISE_KEY,
      kind: "github",
      gitUser: "x-access-token",
    });
    expect(statSync(join(forges, "github.example.com", "sign-in.json")).mode & 0o777).toBe(0o600);
    expect(hostEnv()).toMatchObject({ GIT_ASKPASS: askpass, INFINITARY_GIT_SIGNIN_DIR: forges });
    expect(hostEnv().GIT_CONFIG_PARAMETERS).toContain(
      "'credential.https://github.example.com.helper='",
    );
    // Nothing the home said, pushed or saved holds the key.
    expect(JSON.stringify([world.emitted, world.events, world.signIns.view()])).not.toContain(
      ENTERPRISE_KEY,
    );
    expect(savedText(world.homeDir).filter(({ text }) => text.includes(ENTERPRISE_KEY))).toEqual(
      [],
    );
    expect(servers.asked).toContainEqual({
      url: "https://github.example.com/api/v3/user",
      auth: expect.stringContaining(ENTERPRISE_KEY),
    });

    await world.signIns.signOutForge(world.deviceId, "github.example.com");
    await expect.poll(() => world.group()?.signIns?.forges?.signIns).toEqual([]);
    expect(existsSync(join(forges, "github.example.com"))).toBe(false);
  });

  it("signs a computer in to GitLab on the person's own server with a browser code read at home", async () => {
    const servers = standInServers();
    const world = await joined({ gitAskpass: join(__dirname, "../../../resources/git-askpass") });
    world.signIns.read();
    await expect
      .poll(() => world.group()?.signIns?.forges?.servers)
      .toEqual([GITHUB_ENTERPRISE, GITLAB, BITBUCKET]);
    // Until then its git keeps the computer's own login for every GitLab
    // host, gitlab.com included (review of INF-4287, the captain's choice:
    // only a host with a sign-in here is answered by the app alone).
    const helpers = () => hostEnv().GIT_CONFIG_PARAMETERS ?? "";
    expect(helpers()).toContain("'credential.https://github.com.helper='");
    expect(helpers()).not.toContain("gitlab");

    const { signInId } = await world.signIns.forgeBrowser(world.deviceId, {
      kind: "gitlab",
      address: "gitlab.example.com",
      applicationId: GITLAB_APPLICATION,
    });
    await expect
      .poll(() => world.steps(signInId).find((step) => step.kind === "notice"))
      .toMatchObject({
        notice: {
          providerId: "gitlab.example.com",
          kind: "device_code",
          userCode: "GLAB-0042",
          url: "https://gitlab.example.com/oauth/device",
        },
      });
    // The captain enters the code on GitLab's page; the computer asks until it says yes.
    expect(await world.ended(signInId)).toEqual({ kind: "ended", outcome: "signed-in" });
    await expect
      .poll(() => world.group()?.signIns?.forges?.signIns)
      .toEqual([
        expect.objectContaining({
          host: "gitlab.example.com",
          login: "tanuki",
          state: "ok",
          server: GITLAB,
          applicationId: GITLAB_APPLICATION,
        }),
      ]);
    expect(
      new ForgeSignInStore(join(world.dataDir, "forges")).read("gitlab.example.com"),
    ).toMatchObject({
      token: GITLAB_SIGN_IN,
      kind: "gitlab",
      gitUser: "oauth2",
      applicationId: GITLAB_APPLICATION,
    });
    // Signed in, that host is answered by the app's sign-in alone; gitlab.com,
    // with none here, still keeps the computer's own.
    expect(helpers()).toContain("'credential.https://gitlab.example.com.helper='");
    expect(helpers()).not.toContain("'credential.https://gitlab.com.helper='");
    expect(servers.asked).toContainEqual({
      url: "https://gitlab.example.com/api/v4/user",
      auth: `Bearer ${GITLAB_SIGN_IN}`,
    });
    expect(JSON.stringify([world.emitted, world.events, world.signIns.view()])).not.toContain(
      GITLAB_SIGN_IN,
    );
  });

  // INF-5192: each computer's own Bitbucket sign-in, made with an API token typed at home.
  it("signs a computer in to Bitbucket with an API token typed at home, which its git answers bitbucket.org with", async () => {
    const servers = standInServers();
    const world = await joined({ gitAskpass: join(__dirname, "../../../resources/git-askpass") });
    world.signIns.read();
    await expect
      .poll(() => world.group()?.signIns?.forges?.servers)
      .toEqual([GITHUB_ENTERPRISE, GITLAB, BITBUCKET]);
    // Until then its git keeps the computer's own login for bitbucket.org.
    const helpers = () => hostEnv().GIT_CONFIG_PARAMETERS ?? "";
    expect(helpers()).not.toContain("bitbucket");

    expect(
      await world.signIns.forgeWithKey(world.deviceId, {
        kind: "bitbucket",
        address: "bitbucket.org",
        key: "ATATT3xFfGF0standin_revoked-0042=FFFF0000",
      }),
    ).toEqual({ ok: false, problem: "refused", host: "bitbucket.org" });
    expect(existsSync(join(world.dataDir, "forges", "bitbucket.org"))).toBe(false);
    expect(
      await world.signIns.forgeWithKey(world.deviceId, {
        kind: "bitbucket",
        address: "https://bitbucket.org/team/api",
        key: BITBUCKET_KEY,
      }),
    ).toEqual({ ok: true, host: "bitbucket.org" });
    await expect
      .poll(() => world.group()?.signIns?.forges?.signIns)
      .toEqual([
        expect.objectContaining({
          host: "bitbucket.org",
          name: "Bitbucket",
          login: "octo",
          state: "ok",
          server: BITBUCKET,
        }),
      ]);
    const forges = join(world.dataDir, "forges");
    expect(new ForgeSignInStore(forges).read("bitbucket.org")).toMatchObject({
      token: BITBUCKET_KEY,
      kind: "bitbucket",
      gitUser: "x-bitbucket-api-token-auth",
    });
    expect(statSync(join(forges, "bitbucket.org", "sign-in.json")).mode & 0o777).toBe(0o600);
    // Signed in, bitbucket.org is answered by the app's sign-in alone there.
    expect(helpers()).toContain("'credential.https://bitbucket.org.helper='");
    expect(servers.asked).toContainEqual({
      url: "https://api.bitbucket.org/2.0/user",
      auth: `Bearer ${BITBUCKET_KEY}`,
    });
    expect(JSON.stringify([world.emitted, world.events, world.signIns.view()])).not.toContain(
      BITBUCKET_KEY,
    );
    expect(savedText(world.homeDir).filter(({ text }) => text.includes(BITBUCKET_KEY))).toEqual([]);

    await world.signIns.signOutForge(world.deviceId, "bitbucket.org");
    await expect.poll(() => world.group()?.signIns?.forges?.signIns).toEqual([]);
    expect(existsSync(join(forges, "bitbucket.org"))).toBe(false);
    expect(helpers()).not.toContain("bitbucket");
  });

  it("offers no GitHub CLI sign-in on a computer without GitHub CLI", async () => {
    const world = await joined();
    world.signIns.read();
    await expect
      .poll(() => world.group()?.signIns?.forges)
      .toEqual({
        signIns: [],
        hosts: [{ host: "github.com", name: "GitHub" }],
        servers: [GITHUB_ENTERPRISE, GITLAB, BITBUCKET],
      });
    await expect(world.signIns.forgeWithCli(world.deviceId, "github.com")).rejects.toThrow(
      "does not offer GitHub CLI's sign-in there",
    );
  });

  it("stops a GitHub sign-in when the home stops it, and says when its code ran out", async () => {
    let expired = false;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      if (url === "https://github.com/login/device/code")
        return json({
          device_code: "standin-github-device",
          user_code: "WDJB-0043",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 1,
        });
      return json({ error: expired ? "expired_token" : "authorization_pending" });
    });
    const world = await joined();
    world.signIns.read();
    await expect.poll(() => world.group()?.signIns?.forges?.hosts.length).toBe(1);

    const stopped = await world.signIns.startForge(world.deviceId, "github.com");
    await expect
      .poll(() => world.steps(stopped.signInId).some((step) => step.kind === "notice"))
      .toBe(true);
    await world.signIns.cancel(stopped.signInId);
    expect(await world.ended(stopped.signInId)).toEqual({ kind: "ended", outcome: "cancelled" });

    expired = true;
    const lapsed = await world.signIns.startForge(world.deviceId, "github.com");
    expect(await world.ended(lapsed.signInId)).toEqual({
      kind: "ended",
      outcome: "failed",
      error: "The code expired.",
    });
    expect(world.group()?.signIns?.forges?.signIns).toEqual([]);
    expect(existsSync(join(world.dataDir, "forges", "github.com"))).toBe(false);
  });
});
