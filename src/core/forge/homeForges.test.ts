/**
 * The home's wiring where projects live (`startHomeForges`) between a
 * Bitbucket sign-in and the crew (docs/forge.md, "Bitbucket sign-in and
 * projects"). INF-5192: a task whose start git refused on bitbucket.org
 * waits behind that sign-in, and a new token the person makes lets the same
 * task start, through the home's own sign-ins, cards and supervisor. Only
 * Bitbucket's API is a stand-in, answering as bitbucket.org does.
 */
import type { HostCapabilities } from "@core/host";
import { forgeSignInCardId } from "@shared/forges";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
} from "../../../tests/helpers/crewHarness";
import { forgeAuthRequired } from "../workspace/forgeAuth";
import { startHomeForges } from "./homeForges";

fakeCrewTimersEachTest();

const HOST = "bitbucket.org";
const API = "https://api.bitbucket.test/2.0";
const ORIGIN = "https://bitbucket.org/field-team/field-notes.git";
const FIRST_KEY = "ATATT3xFfGF0disposable_first-key=0A1B2C3D";
const NEW_KEY = "ATATT3xFfGF0disposable_new-key=4E5F6A7B";
const GIT_REFUSED = `remote: You may not have access to this repository or it no longer exists in this workspace.\nfatal: Authentication failed for '${ORIGIN}/'`;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a Bitbucket sign-in at the home", () => {
  it("holds a start git refused on bitbucket.org behind its sign-in, and starts the same task once a new token replaces the kept one", async () => {
    // Bitbucket's /user answers every token it still accepts; git on the
    // project refused the first one (a token missing a repository scope).
    const accepted = new Set([FIRST_KEY]);
    vi.stubEnv("INFINITARY_BITBUCKET_API_URL", API);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const token = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "");
        if (String(input) !== `${API}/user` || !token || !accepted.has(token))
          return Response.json(
            { type: "error", error: { message: "Token is invalid" } },
            {
              status: 401,
            },
          );
        return Response.json({ type: "user", nickname: "octo", display_name: "Octo Cat" });
      }),
    );
    const ctx = setup(fakeCrewmate());
    const { supervisor, tasks, workspace, cards, sessions } = ctx;
    const forges = startHomeForges({
      host: {
        app: { packaged: false, appDir: ctx.paths.fleetDir, resourcesDir: ctx.paths.fleetDir },
      } as unknown as Pick<HostCapabilities, "app">,
      paths: ctx.paths,
      repos: ctx.repos,
      namingRule: () => null,
      push: () => {},
    });
    forges.attachCrew({ supervisor, tasks, broadcastEvent: () => {} });
    expect(
      await forges.signIns.signInWithKey({ kind: "bitbucket", address: HOST, key: FIRST_KEY }),
    ).toEqual({ ok: true, host: HOST });

    // The start's clone is refused: the home's classifier, with the hosts the
    // sign-ins know, names bitbucket.org, and the task waits behind it.
    const refused = forgeAuthRequired(
      ORIGIN,
      Object.assign(new Error("git clone failed"), { stderr: GIT_REFUSED }),
      forges.signIns.knownHosts(),
    );
    expect(refused).toMatchObject({ host: HOST, place: "Bitbucket" });
    vi.mocked(workspace.createTaskWorktree).mockRejectedValueOnce(refused);
    const { taskId } = await supervisor.intake.commission({
      title: "Field notes",
      intent: intentOf("update the field notes"),
      startAfter: { at: Date.now() - 1 },
    });
    await supervisor.starts.dispatchQueuedTask(taskId);
    expect(tasks.get(taskId)).toMatchObject({
      status: "open",
      gate: { kind: "captain", ref: `forge-sign-in:${HOST}` },
    });
    await vi.waitFor(() =>
      expect(cards().some((card) => card.id === forgeSignInCardId(HOST))).toBe(true),
    );
    expect(sessions.open).not.toHaveBeenCalled();

    // The person makes a new token and keeps it over the first, which /user
    // still accepted: the sign-in stays ok, the card comes down and the same
    // task starts.
    accepted.add(NEW_KEY);
    expect(
      await forges.signIns.signInWithKey({ kind: "bitbucket", address: HOST, key: NEW_KEY }),
    ).toEqual({ ok: true, host: HOST });
    expect(forges.signIns.stateOf(HOST)).toBe("ok");
    await vi.waitFor(() => expect(tasks.get(taskId)?.status).toBe("active"));
    expect(tasks.get(taskId)?.gate).toBeNull();
    expect(tasks.timeline(taskId).map((event) => event.text)).toEqual(
      expect.arrayContaining([expect.stringContaining("the Bitbucket sign-in is ready")]),
    );
    expect(cards().some((card) => card.id === forgeSignInCardId(HOST))).toBe(false);
    expect(sessions.open).toHaveBeenCalledTimes(1);
    expect(await forges.signIns.token(HOST)).toBe(NEW_KEY);
  });
});
