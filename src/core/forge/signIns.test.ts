import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnownForgeHost } from "@shared/forge";
import type { ForgesView } from "@shared/forges";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type GitHubCli, type GitHubCliToken, readGitHubCliToken } from "./githubCli";
import {
  type ForgeDeviceCode,
  type ForgeDeviceResult,
  type ForgeHealthChange,
  type ForgeRenewal,
  type ForgeServer,
  type ForgeSignInProvider,
  ForgeSignInStore,
  ForgeSignIns,
  type ForgeWhoAmI,
  HEALTH_LOG,
  HEALTH_LOG_MAX_BYTES,
} from "./signIns";

/**
 * The app's own sign-ins where projects live (git integration PR 1.2):
 * the files, the five health rules, and the device flow's endings, over a
 * scripted host. The real GitHub endpoints are `providers/github/oauth.test.ts`.
 */

const CODE: ForgeDeviceCode = {
  deviceCode: "dev",
  userCode: "WDJB-MJHT",
  verificationUri: "https://github.com/login/device",
  expiresInS: 900,
  intervalS: 5,
};

function scripted(options: {
  whoAmI?: (token: string) => Promise<ForgeWhoAmI>;
  wait?: (signal: AbortSignal) => Promise<ForgeDeviceResult>;
  start?: () => Promise<ForgeDeviceCode>;
}): ForgeSignInProvider {
  return {
    host: "github.com",
    name: "GitHub",
    start: options.start ?? (async () => CODE),
    wait: (_code, signal) =>
      options.wait?.(signal) ?? Promise.resolve({ outcome: "denied" } as ForgeDeviceResult),
    whoAmI: options.whoAmI ?? (async () => ({ state: "ok", login: "octo" })),
  };
}

function harness(provider: ForgeSignInProvider, now: () => number = () => 1_000) {
  const root = join(scratchDir("infinitary-forges-"), "forges");
  const store = new ForgeSignInStore(root);
  const pushed: ForgesView[] = [];
  const changes: ForgeHealthChange[] = [];
  const service = () =>
    new ForgeSignIns({
      store,
      providers: [provider],
      projectsOn: () => 2,
      push: (view) => pushed.push(view),
      onHealthChange: (change) => changes.push(change),
      now,
    });
  return { root, store, pushed, changes, service };
}

function pushedWhere(pushed: ForgesView[], predicate: (view: ForgesView) => boolean) {
  return new Promise<ForgesView>((resolve) => {
    const poll = () => {
      const last = pushed.at(-1);
      if (last && predicate(last)) resolve(last);
      else setImmediate(poll);
    };
    poll();
  });
}

describe("the store", () => {
  it("keeps one sign-in per host in a 0700 directory and a 0600 file", () => {
    const { root, store } = harness(scripted({}));
    store.write("github.com", { token: "gho_x", scopes: ["repo"], login: "octo", createdAt: 5 });
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "github.com")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "github.com", "sign-in.json")).mode & 0o777).toBe(0o600);
    expect(store.read("github.com")).toEqual({
      token: "gho_x",
      scopes: ["repo"],
      login: "octo",
      createdAt: 5,
    });
    store.remove("github.com");
    expect(existsSync(join(root, "github.com"))).toBe(false);
  });

  it("refuses anything that is not a host name, so no path escapes the store", () => {
    const { store } = harness(scripted({}));
    expect(() => store.dirFor("../accounts")).toThrow();
    expect(() => store.dirFor("github.com/..")).toThrow();
    expect(() => store.dirFor("")).toThrow();
  });
});

describe("signing in", () => {
  it("shows the code, then stores the sign-in and who it is when the person approves", async () => {
    let approve: (result: ForgeDeviceResult) => void = () => {};
    const { store, pushed, changes, service } = harness(
      scripted({ wait: () => new Promise((resolve) => (approve = resolve)) }),
    );
    const signIns = service();
    const flow = await signIns.signIn("github.com");
    expect(flow).toEqual({
      host: "github.com",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresAt: 1_000 + 900_000,
    });
    expect(pushed.at(-1)?.flow).toEqual(flow);
    approve({ outcome: "signed-in", token: "gho_new", scopes: ["repo", "workflow"] });
    const view = await pushedWhere(pushed, (next) => next.signIns.length === 1);
    expect(view.flow).toBeNull();
    expect(view.signIns).toEqual([
      { host: "github.com", name: "GitHub", login: "octo", state: "ok", projects: 2, since: 1_000 },
    ]);
    expect(store.read("github.com")).toMatchObject({ token: "gho_new", login: "octo" });
    expect(changes).toEqual([{ host: "github.com", name: "GitHub", from: "none", to: "ok" }]);
    expect(JSON.stringify(pushed)).not.toContain("gho_new");
  });

  it("says the code expired, and offers nothing else", async () => {
    const { pushed, store, service } = harness(
      scripted({ wait: async () => ({ outcome: "expired" }) }),
    );
    await service().signIn("github.com");
    const view = await pushedWhere(pushed, (next) => next.flow === null && next.ended !== null);
    expect(view.ended).toEqual({ host: "github.com", end: "expired" });
    expect(store.read("github.com")).toBeUndefined();
  });

  it("is quiet when the person says no on the host's page", async () => {
    const { pushed, changes, service } = harness(
      scripted({ wait: async () => ({ outcome: "denied" }) }),
    );
    await service().signIn("github.com");
    const view = await pushedWhere(pushed, (next) => next.flow === null);
    expect(view.ended).toBeNull();
    expect(view.signIns).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("ends the flow on Cancel, and a late answer from the host changes nothing", async () => {
    let finish: (result: ForgeDeviceResult) => void = () => {};
    let aborted = false;
    const { store, service } = harness(
      scripted({
        wait: (signal) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          return new Promise((resolve) => (finish = resolve));
        },
      }),
    );
    const signIns = service();
    await signIns.signIn("github.com");
    signIns.cancel();
    expect(aborted).toBe(true);
    expect(signIns.view().flow).toBeNull();
    finish({ outcome: "signed-in", token: "gho_late", scopes: [] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.read("github.com")).toBeUndefined();
  });

  it("says it could not reach the host when the flow cannot start", async () => {
    const { pushed, service } = harness(
      scripted({
        start: async () => {
          throw new Error("could not reach GitHub: ECONNREFUSED");
        },
      }),
    );
    await expect(service().signIn("github.com")).rejects.toThrow("ECONNREFUSED");
    expect(pushed.at(-1)?.ended).toEqual({ host: "github.com", end: "failed" });
  });

  it("tells whoever started a flow how it ended, once: signed in, expired, refused, failed or stopped", async () => {
    const endings = async (
      wait: (signal: AbortSignal) => Promise<ForgeDeviceResult>,
      act?: (signIns: ForgeSignIns) => void,
    ) => {
      const said: string[] = [];
      const signIns = harness(scripted({ wait })).service();
      await signIns.signIn("github.com", { onEnd: (ending) => said.push(ending) });
      act?.(signIns);
      for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
      return said;
    };
    expect(
      await endings(async () => ({ outcome: "signed-in", token: "gho_y", scopes: ["repo"] })),
    ).toEqual(["signed-in"]);
    expect(await endings(async () => ({ outcome: "expired" }))).toEqual(["expired"]);
    expect(await endings(async () => ({ outcome: "denied" }))).toEqual(["denied"]);
    expect(
      await endings(async () => {
        throw new Error("GitHub answered 502");
      }),
    ).toEqual(["failed"]);
    const never = () => new Promise<ForgeDeviceResult>(() => {});
    expect(await endings(never, (signIns) => signIns.cancel())).toEqual(["cancelled"]);
    expect(await endings(never, (signIns) => signIns.signOut("github.com"))).toEqual(["cancelled"]);
    // A newer flow takes the screen: the first ends cancelled, the second goes on.
    const first: string[] = [];
    const second: string[] = [];
    const signIns = harness(scripted({ wait: never })).service();
    await signIns.signIn("github.com", { onEnd: (ending) => first.push(ending) });
    await signIns.signIn("github.com", { onEnd: (ending) => second.push(ending) });
    expect(first).toEqual(["cancelled"]);
    expect(second).toEqual([]);
  });

  it("signs out by deleting the host's directory", () => {
    const { root, store, changes, service } = harness(scripted({}));
    store.write("github.com", { token: "gho_x", scopes: [], login: "octo", createdAt: 1 });
    const signIns = service();
    signIns.signOut("github.com");
    expect(existsSync(join(root, "github.com"))).toBe(false);
    expect(signIns.view().signIns).toEqual([]);
    expect(changes).toEqual([{ host: "github.com", name: "GitHub", from: "unknown", to: "none" }]);
  });
});

describe("health, through the five rules", () => {
  function signedIn(whoAmI: (token: string) => Promise<ForgeWhoAmI>) {
    const h = harness(scripted({ whoAmI }));
    h.store.write("github.com", { token: "gho_x", scopes: [], login: "octo", createdAt: 1 });
    return { ...h, signIns: h.service() };
  }

  it("is unknown until the host has answered, never absent", () => {
    const { signIns } = signedIn(async () => ({ state: "ok", login: "octo" }));
    expect(signIns.view().signIns[0]?.state).toBe("unknown");
  });

  it("is ok when the host answers who the person is, and keeps its login fresh", async () => {
    const { signIns, store } = signedIn(async () => ({ state: "ok", login: "renamed" }));
    await signIns.checkHealth();
    expect(signIns.view().signIns[0]).toMatchObject({ state: "ok", login: "renamed" });
    expect(store.read("github.com")).toMatchObject({ login: "renamed", token: "gho_x" });
  });

  it("needs a new sign-in only on the host's own refusal, announced once", async () => {
    const { signIns, changes } = signedIn(async () => ({ state: "rejected" }));
    await signIns.checkHealth();
    await signIns.checkHealth();
    expect(signIns.view().signIns[0]?.state).toBe("needs_reauth");
    expect(changes).toEqual([
      { host: "github.com", name: "GitHub", from: "unknown", to: "needs_reauth" },
    ]);
  });

  it("is unavailable - never signed out - when the host cannot be reached", async () => {
    const { signIns, store } = signedIn(async () => ({ state: "unavailable", reason: "503" }));
    await signIns.checkHealth();
    expect(signIns.view().signIns[0]?.state).toBe("unavailable");
    expect(store.read("github.com")).toMatchObject({ token: "gho_x" });
  });

  it("recovers when the host answers again after a new sign-in", async () => {
    let answer: ForgeWhoAmI = { state: "rejected" };
    const { signIns, changes } = signedIn(async () => answer);
    await signIns.checkHealth();
    answer = { state: "ok", login: "octo" };
    await signIns.checkHealth();
    expect(changes.map((change) => change.to)).toEqual(["needs_reauth", "ok"]);
  });

  it("reads an unreadable store as unknown and asks the host nothing", async () => {
    let asked = 0;
    const h = harness(
      scripted({
        whoAmI: async () => {
          asked += 1;
          return { state: "ok", login: "x" };
        },
      }),
    );
    mkdirSync(join(h.root, "github.com"), { recursive: true });
    writeFileSync(join(h.root, "github.com", "sign-in.json"), "{broken");
    const signIns = h.service();
    await signIns.checkHealth();
    expect(signIns.view().signIns[0]?.state).toBe("unknown");
    expect(asked).toBe(0);
    // The review of INF-5409: the file is there, so a first launch counts it, without reading it.
    expect(signIns.present("github.com")).toBe(true);
    expect(signIns.presentHosts()).toEqual(["github.com"]);
    rmSync(join(h.root, "github.com", "sign-in.json"));
    expect(signIns.present("github.com")).toBe(false);
    expect(signIns.presentHosts()).toEqual([]);
  });

  it("with nothing signed in, checks nothing and says nothing", async () => {
    let asked = 0;
    const { service, pushed, changes } = harness(
      scripted({
        whoAmI: async () => {
          asked += 1;
          return { state: "ok", login: "x" };
        },
      }),
    );
    await service().checkHealth();
    expect(asked).toBe(0);
    expect(pushed).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("asks the host again when a request was refused, sharing one read", async () => {
    let asked = 0;
    const { signIns } = signedIn(async () => {
      asked += 1;
      return { state: "rejected" };
    });
    signIns.rejected("github.com");
    signIns.rejected("github.com");
    await signIns.checkHealth();
    expect(asked).toBe(1);
    expect(signIns.stateOf("github.com")).toBe("needs_reauth");
  });
});

describe("the health log", () => {
  const at = (iso: string) => Date.parse(iso);

  it("dates every change of health with the host's answer, across a restart and a sign-out, and never holds the sign-in", async () => {
    let clock = at("2026-09-24T19:16:00.000Z");
    let answer: ForgeWhoAmI = { state: "ok", login: "octo", status: 200 };
    const h = harness(
      scripted({
        whoAmI: async () => answer,
        wait: async () => ({ outcome: "signed-in", token: "gho_never_logged", scopes: ["repo"] }),
      }),
      () => clock,
    );
    const signIns = h.service();
    await signIns.signIn("github.com");
    await pushedWhere(h.pushed, (view) => view.flow === null && view.signIns.length === 1);
    await signIns.checkHealth();

    clock = at("2026-09-24T21:03:00.000Z");
    answer = { state: "rejected", status: 401 };
    await signIns.checkHealth();
    await signIns.checkHealth();

    clock = at("2026-09-24T21:04:00.000Z");
    answer = { state: "unavailable", reason: "503", status: 503 };
    await signIns.checkHealth();
    answer = { state: "unavailable", reason: "unreachable: fetch failed" };
    await signIns.checkHealth();

    clock = at("2026-09-24T21:05:00.000Z");
    answer = { state: "ok", login: "octo", status: 200 };
    await signIns.checkHealth();

    // A restart: the next process reads the same store from nothing.
    clock = at("2026-09-25T08:00:00.000Z");
    answer = { state: "rejected", status: 401 };
    const restarted = h.service();
    await restarted.checkHealth();
    clock = at("2026-09-25T08:01:00.000Z");
    restarted.signOut("github.com");

    const file = join(h.root, HEALTH_LOG);
    const text = readFileSync(file, "utf8");
    expect(text.trimEnd().split("\n")).toEqual([
      "2026-09-24T19:16:00.000Z github.com sign-in none -> ok (signed in, answered 200)",
      "2026-09-24T21:03:00.000Z github.com sign-in ok -> needs_reauth (answered 401)",
      "2026-09-24T21:04:00.000Z github.com sign-in needs_reauth -> unavailable (503)",
      "2026-09-24T21:05:00.000Z github.com sign-in unavailable -> ok (answered 200)",
      "2026-09-25T08:00:00.000Z github.com sign-in unknown -> needs_reauth (answered 401)",
      "2026-09-25T08:01:00.000Z github.com sign-in needs_reauth -> none (signed out)",
    ]);
    expect(text).not.toContain("gho_never_logged");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(join(h.root, "github.com"))).toBe(false);
  });

  it("dates each start and quit with the sign-in on file, bracketing one that died while the app was closed", async () => {
    let clock = at("2026-09-24T19:00:00.000Z");
    let answer: ForgeWhoAmI = { state: "ok", login: "octo", status: 200 };
    const h = harness(scripted({ whoAmI: async () => answer }), () => clock);
    // Never signed in here: nothing to say, and no file made.
    h.service().recordApp("start");
    expect(existsSync(h.root)).toBe(false);

    h.store.write("github.com", {
      token: "gho_never_logged",
      scopes: ["repo"],
      login: "octo",
      createdAt: at("2026-09-24T19:16:00.000Z"),
    });
    clock = at("2026-09-24T19:30:00.000Z");
    const first = h.service();
    first.recordApp("start");
    await first.checkHealth();
    clock = at("2026-09-24T23:00:00.000Z");
    first.recordApp("quit");

    clock = at("2026-09-25T09:52:10.000Z");
    answer = { state: "rejected", status: 401 };
    const second = h.service();
    second.recordApp("start");
    await second.checkHealth();
    clock = at("2026-09-25T09:53:00.000Z");
    second.signOut("github.com");
    second.recordApp("quit");

    const text = readFileSync(join(h.root, HEALTH_LOG), "utf8");
    expect(text.trimEnd().split("\n")).toEqual([
      "2026-09-24T19:30:00.000Z github.com app start: signed in since 2026-09-24T19:16:00.000Z",
      "2026-09-24T19:30:00.000Z github.com sign-in unknown -> ok (answered 200)",
      "2026-09-24T23:00:00.000Z github.com app quit: signed in since 2026-09-24T19:16:00.000Z, last read ok",
      "2026-09-25T09:52:10.000Z github.com app start: signed in since 2026-09-24T19:16:00.000Z",
      "2026-09-25T09:52:10.000Z github.com sign-in unknown -> needs_reauth (answered 401)",
      "2026-09-25T09:53:00.000Z github.com sign-in needs_reauth -> none (signed out)",
      "2026-09-25T09:53:00.000Z github.com app quit: not signed in",
    ]);
    expect(text).not.toContain("gho_never_logged");
  });

  it("names an unreadable sign-in file, and an answer with a status its reason does not carry", async () => {
    const h = harness(
      scripted({
        whoAmI: async () => ({ state: "unavailable", reason: "unreadable answer", status: 200 }),
      }),
    );
    h.store.write("github.com", { token: "gho_x", scopes: [], login: "octo", createdAt: 1 });
    const signIns = h.service();
    await signIns.checkHealth();
    writeFileSync(join(h.root, "github.com", "sign-in.json"), "{broken");
    await signIns.checkHealth();
    expect(readFileSync(join(h.root, HEALTH_LOG), "utf8").trimEnd().split("\n")).toEqual([
      "1970-01-01T00:00:01.000Z github.com sign-in unknown -> unavailable (200, unreadable answer)",
      "1970-01-01T00:00:01.000Z github.com sign-in unavailable -> unknown (the sign-in file is unreadable)",
    ]);
  });

  it("keeps its newest whole lines once it outgrows its size", async () => {
    const h = harness(scripted({ whoAmI: async () => ({ state: "rejected", status: 401 }) }));
    h.store.write("github.com", { token: "gho_x", scopes: [], login: "octo", createdAt: 1 });
    const old = Array.from(
      { length: 1_200 },
      (_, i) => `old line ${String(i).padStart(4, "0")} ${"x".repeat(50)}`,
    );
    writeFileSync(join(h.root, HEALTH_LOG), `${old.join("\n")}\n`);
    await h.service().checkHealth();
    const file = join(h.root, HEALTH_LOG);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(statSync(file).size).toBeLessThanOrEqual(HEALTH_LOG_MAX_BYTES / 2);
    expect(lines.at(-1)).toBe(
      "1970-01-01T00:00:01.000Z github.com sign-in unknown -> needs_reauth (answered 401)",
    );
    expect(lines).not.toContain(old[0]);
    expect(lines.slice(0, -1).every((line) => old.includes(line))).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

/**
 * GitHub as it treats an OAuth App's sign-in since 2026-08-14 (the
 * owner's app, registered 09-24): eight hours of access, a refresh token
 * that works once and retires the access token it came with, and a
 * refusal - never a new pair - for a spent refresh token.
 */
function shortLivedGitHub(clock: () => number) {
  const live = new Set<string>();
  const refreshes: string[] = [];
  let liveRefresh = "";
  let renewed = 0;
  let answer: "renew" | "refuse" | "down" = "renew";
  let hold: Promise<void> | undefined;
  const EIGHT_HOURS_S = 8 * 60 * 60;
  const provider: ForgeSignInProvider = {
    host: "github.com",
    name: "GitHub",
    start: async () => CODE,
    wait: async () => {
      live.add("gho_first");
      liveRefresh = "ghr_1";
      return {
        outcome: "signed-in",
        token: "gho_first",
        scopes: ["read:org", "repo", "workflow"],
        refreshToken: "ghr_1",
        expiresInS: EIGHT_HOURS_S,
        refreshExpiresInS: 15_897_600,
      };
    },
    whoAmI: async (token) =>
      live.has(token)
        ? { state: "ok", login: "octo", status: 200 }
        : { state: "rejected", status: 401 },
    renew: async (refreshToken): Promise<ForgeRenewal> => {
      refreshes.push(refreshToken);
      await hold;
      if (answer === "down") return { outcome: "unavailable", reason: "unreachable: fetch failed" };
      if (answer === "refuse" || refreshToken !== liveRefresh) {
        return { outcome: "refused", reason: "bad_refresh_token" };
      }
      renewed += 1;
      live.clear();
      const token = `gho_renewed_${renewed}`;
      live.add(token);
      liveRefresh = `ghr_${renewed + 1}`;
      return {
        outcome: "renewed",
        token,
        scopes: ["read:org", "repo", "workflow"],
        refreshToken: liveRefresh,
        expiresInS: EIGHT_HOURS_S,
        refreshExpiresInS: 15_897_600,
      };
    },
  };
  return {
    provider,
    refreshes,
    /** The eight hours ran out on GitHub's side. */
    endAccess: () => live.clear(),
    answerRenewals: (next: typeof answer) => {
      answer = next;
    },
    holdRenewals: () => {
      let release = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        hold = undefined;
        release();
      };
    },
    clock,
  };
}

describe("a short-lived sign-in renews itself (the owner's sign-in, dead eight hours in)", () => {
  const at = (iso: string) => Date.parse(iso);

  function setup() {
    let clock = at("2026-09-24T19:16:00.000Z");
    const github = shortLivedGitHub(() => clock);
    const root = join(scratchDir("infinitary-forges-"), "forges");
    const store = new ForgeSignInStore(root);
    const changes: ForgeHealthChange[] = [];
    const renewed: string[] = [];
    const pushed: ForgesView[] = [];
    const service = () =>
      new ForgeSignIns({
        store,
        providers: [github.provider],
        projectsOn: () => 1,
        push: (view) => pushed.push(view),
        onHealthChange: (change) => changes.push(change),
        onRenewed: (host) => renewed.push(host),
        now: () => clock,
      });
    const signIns = service();
    return {
      github,
      root,
      store,
      changes,
      renewed,
      pushed,
      service,
      signIns,
      setClock: (iso: string) => {
        clock = at(iso);
      },
      log: () => readFileSync(join(root, HEALTH_LOG), "utf8").trimEnd().split("\n"),
    };
  }

  async function signedIn(h: ReturnType<typeof setup>) {
    await h.signIns.signIn("github.com");
    await pushedWhere(h.pushed, (view) => view.flow === null && view.signIns.length === 1);
  }

  it("keeps the refresh token and when the sign-in ends, beside the access token git reads", async () => {
    const h = setup();
    await signedIn(h);
    const file = join(h.root, "github.com", "sign-in.json");
    expect(h.store.read("github.com")).toMatchObject({
      token: "gho_first",
      refreshToken: "ghr_1",
      expiresAt: at("2026-09-25T03:16:00.000Z"),
      refreshExpiresAt: at("2026-09-24T19:16:00.000Z") + 15_897_600_000,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(h.log()).toEqual([
      "2026-09-24T19:16:00.000Z github.com sign-in none -> ok (signed in, answered 200, short-lived until 2026-09-25T03:16:00.000Z)",
    ]);
  });

  it("renews at the next start when it ran out while the app was closed, instead of asking to sign in again", async () => {
    const h = setup();
    await signedIn(h);
    h.setClock("2026-09-24T20:50:00.000Z");
    h.signIns.recordApp("quit");
    h.github.endAccess();
    h.setClock("2026-09-25T16:52:10.000Z");
    const restarted = h.service();
    restarted.recordApp("start");
    await restarted.checkHealth();
    expect(restarted.stateOf("github.com")).toBe("ok");
    expect(h.store.read("github.com")).toMatchObject({
      token: "gho_renewed_1",
      refreshToken: "ghr_2",
      expiresAt: at("2026-09-26T00:52:10.000Z"),
    });
    expect(h.github.refreshes).toEqual(["ghr_1"]);
    expect(h.changes.map((change) => change.to)).toEqual(["ok", "ok"]);
    expect(h.changes.some((change) => change.to === "needs_reauth")).toBe(false);
    expect(h.renewed).toEqual(["github.com"]);
    expect(h.log().slice(1)).toEqual([
      "2026-09-24T20:50:00.000Z github.com app quit: signed in since 2026-09-24T19:16:00.000Z, short-lived until 2026-09-25T03:16:00.000Z, last read ok",
      "2026-09-25T16:52:10.000Z github.com app start: signed in since 2026-09-24T19:16:00.000Z, short-lived until 2026-09-25T03:16:00.000Z",
      "2026-09-25T16:52:10.000Z github.com sign-in renewed, short-lived until 2026-09-26T00:52:10.000Z",
      "2026-09-25T16:52:10.000Z github.com sign-in unknown -> ok (answered 200, after a renewal)",
    ]);
  });

  it("renews ahead of its end on the tick, so GitHub never refuses it while the app runs", async () => {
    const h = setup();
    await signedIn(h);
    h.setClock("2026-09-25T03:00:00.000Z");
    await h.signIns.checkHealth();
    expect(h.github.refreshes).toEqual([]);
    h.setClock("2026-09-25T03:07:00.000Z");
    await h.signIns.checkHealth();
    expect(h.github.refreshes).toEqual(["ghr_1"]);
    expect(await h.signIns.token("github.com")).toBe("gho_renewed_1");
    expect(h.signIns.stateOf("github.com")).toBe("ok");
    expect(h.renewed).toEqual(["github.com"]);
  });

  it("renews once when GitHub refuses it early, and asks again with the new one", async () => {
    const h = setup();
    await signedIn(h);
    h.github.endAccess();
    h.signIns.rejected("github.com");
    await h.signIns.checkHealth();
    expect(h.signIns.stateOf("github.com")).toBe("ok");
    expect(h.github.refreshes).toEqual(["ghr_1"]);
    expect(h.store.read("github.com")).toMatchObject({ token: "gho_renewed_1" });
  });

  it("renews a forge request's sign-in before sending it, one renewal however many ask at once", async () => {
    const h = setup();
    await signedIn(h);
    h.github.endAccess();
    h.setClock("2026-09-25T09:52:10.000Z");
    const release = h.github.holdRenewals();
    const asks = [
      h.signIns.token("github.com"),
      h.signIns.checkHealth(),
      h.signIns.token("github.com"),
    ];
    release();
    const [first, , second] = await Promise.all(asks);
    expect([first, second]).toEqual(["gho_renewed_1", "gho_renewed_1"]);
    expect(h.github.refreshes).toEqual(["ghr_1"]);
    expect(h.signIns.stateOf("github.com")).toBe("ok");
  });

  it("needs a new sign-in only on proof: GitHub refused the refresh token, which is then dropped", async () => {
    const h = setup();
    await signedIn(h);
    h.github.endAccess();
    h.github.answerRenewals("refuse");
    h.setClock("2026-09-25T09:52:10.000Z");
    await h.signIns.checkHealth();
    expect(h.signIns.stateOf("github.com")).toBe("needs_reauth");
    const kept = h.store.read("github.com");
    expect(kept).toMatchObject({ token: "gho_first", login: "octo" });
    expect(kept).not.toHaveProperty("refreshToken");
    await h.signIns.checkHealth();
    expect(h.github.refreshes).toEqual(["ghr_1"]);
    expect(h.log().slice(-2)).toEqual([
      "2026-09-25T09:52:10.000Z github.com sign-in renewal refused (bad_refresh_token)",
      "2026-09-25T09:52:10.000Z github.com sign-in ok -> needs_reauth (answered 401, the renewal was refused (bad_refresh_token))",
    ]);
  });

  it("is unavailable - never a sign-out - when GitHub cannot be asked for the renewal, and renews once it can", async () => {
    const h = setup();
    await signedIn(h);
    h.github.endAccess();
    h.github.answerRenewals("down");
    h.setClock("2026-09-25T09:52:10.000Z");
    await h.signIns.checkHealth();
    expect(h.signIns.stateOf("github.com")).toBe("unavailable");
    expect(h.store.read("github.com")).toMatchObject({ refreshToken: "ghr_1" });
    h.github.answerRenewals("renew");
    await h.signIns.checkHealth();
    expect(h.signIns.stateOf("github.com")).toBe("ok");
    expect(h.changes.map((change) => change.to)).toEqual(["ok", "unavailable", "ok"]);
  });

  it("never writes a renewal over a sign-out or a new sign-in made while GitHub answered", async () => {
    const h = setup();
    await signedIn(h);
    h.github.endAccess();
    h.setClock("2026-09-25T09:52:10.000Z");
    const release = h.github.holdRenewals();
    const read = h.signIns.checkHealth();
    h.signIns.signOut("github.com");
    release();
    await read;
    expect(h.store.read("github.com")).toBeUndefined();
    expect(h.renewed).toEqual([]);
  });
});

describe("the app's git helper over the store's own file", () => {
  const askpass = join(__dirname, "../../../resources/git-askpass");
  const ask = (root: string, prompt: string) =>
    spawnSync(askpass, [prompt], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, INFINITARY_GIT_SIGNIN_DIR: root },
    });

  it("answers git's two questions for a host signed in here", () => {
    const { root, store } = harness(scripted({}));
    store.write("github.com", { token: "gho_line", scopes: [], login: null, createdAt: 1 });
    const user = ask(root, "Username for 'https://github.com': ");
    expect([user.status, user.stdout]).toEqual([0, "x-access-token\n"]);
    const pass = ask(root, "Password for 'https://x-access-token@github.com': ");
    expect([pass.status, pass.stdout]).toEqual([0, "gho_line\n"]);
  });

  it("answers with the access token of a short-lived sign-in, never its refresh token", () => {
    const { root, store } = harness(scripted({}));
    store.write("github.com", {
      token: "gho_access",
      scopes: ["repo"],
      login: "octo",
      createdAt: 1,
      refreshToken: "ghr_refresh",
      expiresAt: 2,
      refreshExpiresAt: 3,
    });
    const pass = ask(root, "Password for 'https://x-access-token@github.com': ");
    expect([pass.status, pass.stdout]).toEqual([0, "gho_access\n"]);
  });

  it("says nothing for any other host, an address that is not https, or a signed-out host", () => {
    const { root, store } = harness(scripted({}));
    store.write("github.com", { token: "gho_line", scopes: [], login: null, createdAt: 1 });
    for (const prompt of [
      "Password for 'https://gitlab.com': ",
      "Password for 'http://github.com': ",
      "Password for 'https://../github.com': ",
      "Password for 'https://github.com.evil.example': ",
    ]) {
      const answer = ask(root, prompt);
      expect([answer.status, answer.stdout], prompt).toEqual([1, ""]);
    }
    store.remove("github.com");
    const gone = ask(root, "Password for 'https://github.com': ");
    expect([gone.status, gone.stdout]).toEqual([1, ""]);
  });

  it("gives a host on the person's own server the user name its sign-in names", () => {
    const { root, store } = harness(scripted({}));
    store.write("git.corp.example", {
      token: "glpat_line",
      scopes: [],
      login: null,
      createdAt: 1,
      kind: "gitlab",
      gitUser: "oauth2",
    });
    const user = ask(root, "Username for 'https://git.corp.example': ");
    expect([user.status, user.stdout]).toEqual([0, "oauth2\n"]);
    const pass = ask(root, "Password for 'https://oauth2@git.corp.example': ");
    expect([pass.status, pass.stdout]).toEqual([0, "glpat_line\n"]);
  });
});

/**
 * A host on the person's own server (`docs/forge.md`, "Hosts on your own
 * server"): GitHub Enterprise signs in with a key the person makes there,
 * checked with the host before it is kept, over a scripted server.
 */
describe("a key sign-in to a host on the person's own server", () => {
  const KEY = "ghp_enterprise_key_0123456789";

  function serverHarness(options: {
    whoAmI?: (host: string, token: string) => Promise<ForgeWhoAmI>;
    projectHosts?: KnownForgeHost[];
  }) {
    const asked: { host: string; token: string }[] = [];
    const server: ForgeServer = {
      kind: "github",
      name: "GitHub Enterprise",
      gitUser: "x-access-token",
      signIn: (host) => ({
        host,
        name: host,
        server: { kind: "github", name: "GitHub Enterprise" },
        whoAmI: async (token) => {
          asked.push({ host, token });
          return (
            options.whoAmI?.(host, token) ??
            ({ state: "ok", login: "mona", status: 200, scopes: ["repo"] } as ForgeWhoAmI)
          );
        },
      }),
    };
    const root = join(scratchDir("infinitary-forges-"), "forges");
    const store = new ForgeSignInStore(root);
    const pushed: ForgesView[] = [];
    const changes: ForgeHealthChange[] = [];
    const known: KnownForgeHost[] = [];
    const service = () =>
      new ForgeSignIns({
        store,
        providers: [scripted({})],
        servers: [server],
        projectHosts: () => options.projectHosts ?? [],
        onSignedIn: (entry) => known.push(entry),
        projectsOn: () => 1,
        push: (view) => pushed.push(view),
        onHealthChange: (change) => changes.push(change),
        now: () => 5_000,
      });
    return { root, store, pushed, changes, known, asked, service };
  }

  it("asks the host who the key is, then keeps it with its kind and git's user name", async () => {
    const h = serverHarness({});
    const signIns = h.service();
    expect(signIns.view().servers).toEqual([{ kind: "github", name: "GitHub Enterprise" }]);
    const result = await signIns.signInWithKey({
      kind: "github",
      address: "https://GitHub.Corp.Example/acme/meter.git",
      key: `  ${KEY}  `,
    });
    expect(result).toEqual({ ok: true, host: "github.corp.example" });
    expect(h.asked).toEqual([{ host: "github.corp.example", token: KEY }]);
    expect(h.store.read("github.corp.example")).toEqual({
      token: KEY,
      scopes: ["repo"],
      login: "mona",
      createdAt: 5_000,
      kind: "github",
      gitUser: "x-access-token",
    });
    expect(h.known).toEqual([{ host: "github.corp.example", kind: "github" }]);
    expect(h.changes).toEqual([
      { host: "github.corp.example", name: "github.corp.example", from: "none", to: "ok" },
    ]);
    const view = signIns.view();
    expect(view.signIns).toEqual([
      {
        host: "github.corp.example",
        name: "github.corp.example",
        login: "mona",
        state: "ok",
        projects: 1,
        since: 5_000,
        server: { kind: "github", name: "GitHub Enterprise" },
      },
    ]);
    expect(view.hosts).toContainEqual({
      host: "github.corp.example",
      name: "github.corp.example",
      server: { kind: "github", name: "GitHub Enterprise" },
    });
    expect(signIns.knownHosts()).toEqual([{ host: "github.corp.example", kind: "github" }]);
    expect(signIns.signInOn("github.corp.example")).toEqual({
      name: "github.corp.example",
      login: "mona",
      state: "ok",
    });
    expect(await signIns.token("github.corp.example")).toBe(KEY);
    expect(JSON.stringify(h.pushed)).not.toContain(KEY);
    const log = readFileSync(join(h.root, HEALTH_LOG), "utf8");
    expect(log).not.toContain(KEY);
    expect(log).toContain(
      "github.corp.example sign-in none -> ok (signed in with a key, answered 200)",
    );
  });

  it("keeps nothing the host did not answer for, and says why", async () => {
    const answers: Record<string, ForgeWhoAmI> = {
      "refused.example": { state: "rejected", status: 401 },
      "forbidden.example": { state: "unavailable", reason: "403", status: 403 },
      "away.example": { state: "unavailable", reason: "unreachable: ENOTFOUND" },
      "down.example": { state: "unavailable", reason: "502", status: 502 },
      "wiki.example": { state: "unavailable", reason: "404", status: 404 },
    };
    const h = serverHarness({ whoAmI: async (host) => answers[host] as ForgeWhoAmI });
    const signIns = h.service();
    const tried = async (address: string, key = KEY) =>
      signIns.signInWithKey({ kind: "github", address, key });
    expect(await tried("refused.example")).toEqual({
      ok: false,
      problem: "refused",
      host: "refused.example",
    });
    expect(await tried("forbidden.example")).toMatchObject({ problem: "refused" });
    expect(await tried("away.example")).toMatchObject({ problem: "unreachable" });
    expect(await tried("down.example")).toMatchObject({ problem: "unreachable" });
    expect(await tried("wiki.example")).toMatchObject({ problem: "not-server" });
    // What the app can tell without asking anyone.
    expect(await tried("  ")).toEqual({ ok: false, problem: "address", host: null });
    expect(await tried("https://github.com/acme/meter")).toEqual({
      ok: false,
      problem: "public-host",
      host: "github.com",
    });
    expect(await tried("gitlab.com")).toMatchObject({ problem: "not-server" });
    expect(await tried("github.corp.example", "not a key")).toMatchObject({ problem: "key" });
    expect(
      await signIns.signInWithKey({ kind: "gitlab", address: "git.corp.example", key: KEY }),
    ).toMatchObject({ problem: "not-server" });
    expect(h.asked.map((entry) => entry.host)).toEqual([
      "refused.example",
      "forbidden.example",
      "away.example",
      "down.example",
      "wiki.example",
    ]);
    expect(h.store.hosts()).toEqual([]);
    expect(h.known).toEqual([]);
  });

  it("knows a host its projects live on, and a .ghe.com host by its name, before any sign-in", async () => {
    const h = serverHarness({
      projectHosts: [
        { host: "github.corp.example", kind: "github" },
        { host: "github.com", kind: "github" },
        { host: "git.corp.example", kind: "gitlab" },
      ],
    });
    const signIns = h.service();
    // A kind the app offers no sign-in for is not known; a public host is not one.
    expect(signIns.knownHosts()).toEqual([{ host: "github.corp.example", kind: "github" }]);
    expect(signIns.view().hosts).toEqual([
      { host: "github.com", name: "GitHub" },
      {
        host: "github.corp.example",
        name: "github.corp.example",
        server: { kind: "github", name: "GitHub Enterprise" },
      },
    ]);
    expect(signIns.nameOf("octo.ghe.com")).toBe("octo.ghe.com");
    expect(signIns.signInOn("octo.ghe.com")).toBeNull();
    expect(signIns.nameOf("git.corp.example")).toBeUndefined();
    // A host with a key has no code to show.
    await expect(signIns.signIn("github.corp.example")).rejects.toThrow(/key/);
    // Git sets the person's own helpers aside only where the app holds a sign-in.
    expect(signIns.gitHosts()).toEqual(["github.com"]);
    await signIns.signInWithKey({ kind: "github", address: "github.corp.example", key: KEY });
    expect(signIns.gitHosts()).toEqual(["github.com", "github.corp.example"]);
  });

  it("reads its health the same way: the host's refusal asks for a new key, and nothing renews it", async () => {
    let answer: ForgeWhoAmI = { state: "ok", login: "mona", status: 200 };
    const h = serverHarness({ whoAmI: async () => answer });
    const signIns = h.service();
    await signIns.signInWithKey({ kind: "github", address: "github.corp.example", key: KEY });
    answer = { state: "rejected", status: 401 };
    await signIns.checkHealth();
    expect(signIns.stateOf("github.corp.example")).toBe("needs_reauth");
    expect(h.changes.at(-1)).toEqual({
      host: "github.corp.example",
      name: "github.corp.example",
      from: "ok",
      to: "needs_reauth",
    });
    // After a restart the host is still known from its file, and signs out like any other.
    const again = h.service();
    expect(again.knownHosts()).toEqual([{ host: "github.corp.example", kind: "github" }]);
    again.signOut("github.corp.example");
    expect(again.knownHosts()).toEqual([]);
    expect(h.store.hosts()).toEqual([]);
  });
});

/**
 * GitHub through GitHub CLI's own sign-in (INF-1775, the captain: "provide an
 * alternative way for them to connect infinitary with their github, which is
 * through gh cli which they have already setup on their machine"): the file
 * names the way and the program, never the token; `token` asks GitHub CLI
 * and keeps its answer a minute; health asks it afresh. Over a scripted
 * GitHub CLI here, and a real program for the reader and the git helper.
 */
describe("a sign-in through GitHub CLI", () => {
  const PROGRAM = "/opt/homebrew/bin/gh";
  const CLI_TOKEN = "gho_from_github_cli_0123456789";

  function cliHarness(
    options: {
      whoAmI?: (token: string) => Promise<ForgeWhoAmI>;
      answer?: () => GitHubCliToken;
      found?: () => string | undefined;
    } = {},
  ) {
    let clock = 10_000;
    const asked: string[] = [];
    const cli: GitHubCli = {
      find: options.found ?? (() => PROGRAM),
      token: async (program, host) => {
        asked.push(`${program} ${host}`);
        return options.answer?.() ?? { token: CLI_TOKEN };
      },
    };
    const sent: string[] = [];
    const server: ForgeServer = {
      kind: "github",
      name: "GitHub Enterprise",
      gitUser: "x-access-token",
      signIn: (host) => ({
        host,
        name: host,
        server: { kind: "github", name: "GitHub Enterprise" },
        whoAmI: async () => ({ state: "ok", login: "mona", status: 200 }),
      }),
    };
    const provider = scripted({
      whoAmI: async (token) => {
        sent.push(token);
        return (
          options.whoAmI?.(token) ??
          ({
            state: "ok",
            login: "octo",
            status: 200,
            scopes: ["repo", "read:org", "gist"],
          } as const)
        );
      },
    });
    const root = join(scratchDir("infinitary-forges-"), "forges");
    const store = new ForgeSignInStore(root);
    const pushed: ForgesView[] = [];
    const changes: ForgeHealthChange[] = [];
    const service = () =>
      new ForgeSignIns({
        store,
        providers: [provider],
        servers: [server],
        projectsOn: () => 1,
        push: (view) => pushed.push(view),
        onHealthChange: (change) => changes.push(change),
        cli,
        now: () => clock,
      });
    return {
      root,
      store,
      pushed,
      changes,
      asked,
      sent,
      service,
      tick: (ms: number) => {
        clock += ms;
      },
    };
  }

  it("keeps the way and the program, never GitHub CLI's token, and every request asks GitHub CLI", async () => {
    const h = cliHarness();
    const signIns = h.service();
    expect(signIns.view().githubCli).toBe(true);
    expect(await signIns.signInWithCli("github.com")).toEqual({ ok: true, host: "github.com" });
    const file = readFileSync(join(h.root, "github.com", "sign-in.json"), "utf8");
    expect(file).not.toContain(CLI_TOKEN);
    expect(JSON.parse(file)).toEqual({
      scopes: ["repo", "read:org", "gist"],
      login: "octo",
      createdAt: 10_000,
      way: "cli",
      program: PROGRAM,
    });
    expect(signIns.view().signIns).toEqual([
      {
        host: "github.com",
        name: "GitHub",
        login: "octo",
        state: "ok",
        projects: 1,
        since: 10_000,
        way: "cli",
      },
    ]);
    expect(h.changes).toEqual([{ host: "github.com", name: "GitHub", from: "none", to: "ok" }]);
    expect(await signIns.token("github.com")).toBe(CLI_TOKEN);
    expect(JSON.stringify(h.pushed)).not.toContain(CLI_TOKEN);
    expect(readFileSync(join(h.root, HEALTH_LOG), "utf8")).toContain(
      "github.com sign-in none -> ok (signed in through GitHub CLI, answered 200)",
    );
  });

  it("asks GitHub CLI once a minute, and again at once after GitHub refuses a request", async () => {
    const h = cliHarness();
    const signIns = h.service();
    await signIns.signInWithCli("github.com");
    const before = h.asked.length;
    await Promise.all([signIns.token("github.com"), signIns.token("github.com")]);
    expect(h.asked.length).toBe(before);
    h.tick(60_000);
    await Promise.all([signIns.token("github.com"), signIns.token("github.com")]);
    expect(h.asked.length).toBe(before + 1);
    signIns.rejected("github.com");
    await signIns.token("github.com");
    expect(h.asked.length).toBeGreaterThan(before + 1);
  });

  it("asks the person to sign in to GitHub CLI again when it holds none or GitHub refuses it, and recovers on Check now", async () => {
    let answer: GitHubCliToken = {
      problem: "none",
      reason: "GitHub CLI holds no sign-in for github.com",
    };
    let refuse = false;
    const h = cliHarness({
      answer: () => answer,
      whoAmI: async () =>
        refuse ? { state: "rejected", status: 401 } : { state: "ok", login: "octo", status: 200 },
    });
    h.store.write("github.com", {
      token: "",
      scopes: [],
      login: "octo",
      createdAt: 1,
      way: "cli",
      program: PROGRAM,
    });
    const signIns = h.service();
    await signIns.checkNow("github.com");
    expect(signIns.stateOf("github.com")).toBe("needs_reauth");
    answer = { token: CLI_TOKEN };
    refuse = true;
    await signIns.checkNow("github.com");
    expect(signIns.stateOf("github.com")).toBe("needs_reauth");
    refuse = false;
    await signIns.checkNow("github.com");
    expect(signIns.stateOf("github.com")).toBe("ok");
    expect(h.changes.map((change) => change.to)).toEqual(["needs_reauth", "ok"]);
    // Nothing renews it: GitHub CLI refreshes its own token.
    expect(h.store.read("github.com")).toMatchObject({ way: "cli", login: "octo" });
  });

  it("reads a GitHub CLI gone from its path as unknown, and one that would not answer as unavailable", async () => {
    let answer: GitHubCliToken = {
      problem: "missing",
      reason: `GitHub CLI was not found at ${PROGRAM}`,
    };
    const h = cliHarness({ answer: () => answer });
    h.store.write("github.com", {
      token: "",
      scopes: [],
      login: "octo",
      createdAt: 1,
      way: "cli",
      program: PROGRAM,
    });
    const signIns = h.service();
    await signIns.checkNow("github.com");
    expect(signIns.stateOf("github.com")).toBe("unknown");
    expect(await signIns.token("github.com")).toBeUndefined();
    answer = { problem: "failed", reason: "GitHub CLI did not answer in time" };
    await signIns.checkNow("github.com");
    expect(signIns.stateOf("github.com")).toBe("unavailable");
  });

  it("keeps nothing GitHub CLI or the host did not answer for, and says why", async () => {
    let answer: GitHubCliToken = { token: CLI_TOKEN };
    let reading: ForgeWhoAmI = { state: "ok", login: "octo", status: 200 };
    const h = cliHarness({ answer: () => answer, whoAmI: async () => reading });
    const signIns = h.service();
    answer = { problem: "none", reason: "GitHub CLI holds no sign-in for github.com" };
    expect(await signIns.signInWithCli("github.com")).toEqual({
      ok: false,
      problem: "none",
      host: "github.com",
    });
    answer = { token: CLI_TOKEN };
    reading = { state: "rejected", status: 401 };
    expect(await signIns.signInWithCli("github.com")).toMatchObject({
      ok: false,
      problem: "refused",
    });
    reading = { state: "unavailable", reason: "fetch failed" };
    expect(await signIns.signInWithCli("github.com")).toMatchObject({
      ok: false,
      problem: "unreachable",
    });
    expect(await signIns.signInWithCli("gitlab.com")).toMatchObject({
      ok: false,
      problem: "not-github",
    });
    expect(h.store.read("github.com")).toBeUndefined();
    const missing = cliHarness({ found: () => undefined });
    const without = missing.service();
    expect(without.view().githubCli).toBeUndefined();
    expect(await without.signInWithCli("github.com")).toMatchObject({
      ok: false,
      problem: "missing",
    });
  });

  it("signs a GitHub Enterprise host in by its address, with its kind and git's user name", async () => {
    const h = cliHarness();
    const signIns = h.service();
    expect(await signIns.signInWithCli("https://github.corp.example/acme/meter")).toEqual({
      ok: true,
      host: "github.corp.example",
    });
    expect(h.asked).toEqual([`${PROGRAM} github.corp.example`]);
    expect(h.store.read("github.corp.example")).toMatchObject({
      kind: "github",
      gitUser: "x-access-token",
      way: "cli",
      login: "mona",
    });
    expect(signIns.knownHosts()).toContainEqual({ host: "github.corp.example", kind: "github" });
    expect(signIns.gitHosts()).toContain("github.corp.example");
  });

  it("forgets only the app's file when signed out; GitHub CLI is not asked to sign out", async () => {
    const h = cliHarness();
    const signIns = h.service();
    await signIns.signInWithCli("github.com");
    const asked = h.asked.length;
    signIns.signOut("github.com");
    expect(existsSync(join(h.root, "github.com"))).toBe(false);
    expect(h.asked.length).toBe(asked);
    expect(await signIns.token("github.com")).toBeUndefined();
  });

  describe("over a real program", () => {
    /** A stand-in GitHub CLI: answers `auth token --hostname github.com`, and nothing else. */
    function program(): string {
      const dir = scratchDir("infinitary-gh-");
      const path = join(dir, "gh");
      writeFileSync(
        path,
        `#!/bin/sh\nif [ "$1 $2 $3 $4" = "auth token --hostname github.com" ]; then echo ${CLI_TOKEN}; exit 0; fi\necho "no oauth token found for $4" >&2\nexit 1\n`,
        { mode: 0o755 },
      );
      return path;
    }

    it("reads GitHub CLI's token, a host it holds none for, and a program that is gone", async () => {
      const gh = program();
      const env = { PATH: process.env.PATH };
      expect(await readGitHubCliToken(gh, "github.com", env)).toEqual({ token: CLI_TOKEN });
      expect(await readGitHubCliToken(gh, "github.corp.example", env)).toMatchObject({
        problem: "none",
      });
      expect(await readGitHubCliToken(join(gh, "..", "nothing"), "github.com", env)).toMatchObject({
        problem: "missing",
      });
    });

    it("lets the app's git helper answer git with GitHub CLI's token for a sign-in through it", () => {
      const gh = program();
      const { root, store } = harness(scripted({}));
      store.write("github.com", {
        token: "",
        scopes: [],
        login: "octo",
        createdAt: 1,
        way: "cli",
        program: gh,
      });
      const askpass = join(__dirname, "../../../resources/git-askpass");
      const ask = (prompt: string) =>
        spawnSync(askpass, [prompt], {
          encoding: "utf8",
          env: { PATH: process.env.PATH, INFINITARY_GIT_SIGNIN_DIR: root },
        });
      expect(ask("Username for 'https://github.com': ").stdout).toBe("x-access-token\n");
      const pass = ask("Password for 'https://x-access-token@github.com': ");
      expect([pass.status, pass.stdout]).toEqual([0, `${CLI_TOKEN}\n`]);
    });
  });
});
