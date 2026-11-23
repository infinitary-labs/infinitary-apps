import { generateKeyPairSync, sign } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import {
  SECRET_APPROVAL_CARD_WORDS,
  SECRET_DEVICE_WORDS,
  SECRETS_WORDS,
  type SecretEntryInput,
} from "@shared/secrets";
import { describe, expect, it, vi } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { SecretUsesThere } from "../helper/secretUses";
import { decisionMessage } from "./approvals";
import { ProtectedSecrets } from "./protected";
import type { EndedUseReceipt } from "./requests";
import { SecretsSettings } from "./settings";

// Intent: INF-4207 piece 6, "Secrets from any computer": a crewmate on a
// computer that runs work asks for a use of a secret, Secrets on the home
// decides it with its own card, saved decisions and history, and the approved
// program there receives the value (decision 7). The captain's checks include
// "two approvals at once running the program once". The home and the work
// computer's command are the real owners, joined by the two work requests
// they would send over the work route; custody and the home's confirmation
// are stand-ins, and each program is a real /bin/sh run.
//
// Integration budget (docs/test-cohorts.md): each case starts one or two
// /bin/sh programs through the recipient's private copies; a case took under
// 0.5 s on an Apple silicon Mac.
const BUDGET = { timeout: 10_000 };
const TOKEN = "ghp_invented-elsewhere-token";
const INPUT = {
  ref: "deploy-token",
  label: "Deploy token",
  value: TOKEN,
  expectedVersion: 0,
  expectedRevision: null,
  environment: "Production",
} satisfies SecretEntryInput;
type Raised = Omit<Card, "author" | "priority" | "status" | "createdAt">;
const BUILD_MAC = { id: "work-mac-1", label: "Build Mac" };
const OTHER_MAC = { id: "work-mac-2", label: "Studio Mac" };
const TASK = "deploy-task";

function home() {
  const custody = disposableCustody();
  const dir = scratchDir("secrets-elsewhere-home-");
  const cards: Raised[] = [];
  const ended: { task: string; receipt: EndedUseReceipt }[] = [];
  const settings = new SecretsSettings({
    open: (initialize) =>
      ProtectedSecrets.open({
        dir,
        custody,
        initialize,
        environment: () => ({}),
        authentication: { available: async () => true, confirm: async () => true },
      }),
    raise: (card) => {
      cards.push(card);
    },
    withdraw: () => {},
    settled: (task, receipt) => {
      ended.push({ task, receipt });
    },
    changed: () => {},
    taskTitle: () => "Deploy the site",
  });
  const click = async (label: string, card = cards.at(-1)) => {
    const effect = card?.actions.find((action) => action.label === label)?.effect;
    if (effect?.kind !== "host" || effect.op !== "secrets-decision" || !effect.arg)
      throw new Error("No trusted action with that label.");
    await settings.decide(effect.arg);
  };
  return { settings, cards, ended, click };
}

/**
 * A work computer's Secrets command for the task, reaching the home only
 * through its two work requests, each a call of its own. With `dropped`, the
 * first send of each take is cut off with its connection, still waiting at
 * the home, and the work route asks the same call again.
 */
function workComputer(
  settings: SecretsSettings,
  computer: typeof BUILD_MAC,
  dropped?: Promise<unknown>[],
) {
  const context = { task: TASK, computer };
  let calls = 0;
  return new SecretUsesThere({
    home: {
      list: async () => [],
      use: (input) => settings.elsewhere(context, structuredClone(input)),
      take: (request) => {
        calls += 1;
        const call = `take-${calls}`;
        dropped?.push(settings.take(context, request, call));
        return settings.take(context, request, call);
      },
    },
    runsDir: scratchDir("secrets-elsewhere-runs-"),
    environment: () => ({ PATH: "/usr/bin:/bin" }),
  });
}

/** A program in the task's folder there that appends what it received to a file. */
async function program() {
  const cwd = await realpath(scratchDir("secrets-elsewhere-task-"));
  const out = join(cwd, "received.txt");
  const script = join(cwd, "deploy.sh");
  await writeFile(script, `printf '%s\\n' "$DEPLOY_TOKEN" >> '${out}'\n`);
  const lines = async () =>
    (await readFile(out, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return {
    use: (id: string) => ({
      id,
      reason: "Deploy the site",
      cwd,
      argv: ["/bin/sh", script],
      env: { DEPLOY_TOKEN: INPUT.ref },
    }),
    lines,
  };
}

describe("Secrets used from a computer that runs work", () => {
  it(
    "the home's card names the computer, and the approved program there receives the value once",
    BUDGET,
    async () => {
      const h = home();
      await h.settings.put(INPUT);
      const there = workComputer(h.settings, BUILD_MAC);
      const run = await program();

      const asked = await there.inject(run.use("deploy"));
      expect(asked.state).toBe("waiting");
      const card = h.cards.at(-1);
      expect(card?.body).toContain(SECRET_APPROVAL_CARD_WORDS.on);
      expect(card?.body).toContain(BUILD_MAC.label);
      // A decision saved from this card covers only that computer, and the card says so.
      expect(card?.body).toContain(SECRET_APPROVAL_CARD_WORDS.alwaysOn(BUILD_MAC.label));
      expect(await run.lines()).toEqual([]);

      await h.click(SECRETS_WORDS.once);
      await vi.waitFor(() => expect(h.ended).toHaveLength(1));
      expect(h.ended[0]).toMatchObject({
        task: TASK,
        receipt: { request: asked.request, state: "completed", exitCode: 0 },
      });
      expect(await run.lines()).toEqual([TOKEN]);
      const history = (await h.settings.view()).history.find(
        (one) => one.request === asked.request,
      );
      expect(history).toMatchObject({ state: "completed", computer: BUILD_MAC.label });
      // The values left once: another take there answers how the use ended, never the value.
      expect(
        await h.settings.take({ task: TASK, computer: BUILD_MAC }, asked.request, "take-again"),
      ).toEqual({ state: "completed" });
      expect(
        await h.settings.take({ task: TASK, computer: OTHER_MAC }, asked.request, "take-other"),
      ).toEqual({ state: "unavailable" });
      expect(
        await h.settings.elsewhere(
          { task: "another-task", computer: BUILD_MAC },
          { op: "status", request: asked.request },
        ),
      ).toEqual({ receipt: null });
    },
  );

  it(
    "a decision saved for one computer does not cover the same program on another",
    BUDGET,
    async () => {
      const h = home();
      await h.settings.put(INPUT);
      const build = workComputer(h.settings, BUILD_MAC);
      const studio = workComputer(h.settings, OTHER_MAC);
      const run = await program();

      const first = await build.inject(run.use("deploy-saved"));
      expect(first.state).toBe("waiting");
      await h.click(SECRETS_WORDS.always);
      await vi.waitFor(() => expect(h.ended).toHaveLength(1));

      const { cwd, argv, env } = run.use("check");
      expect(await build.check({ cwd, argv, env })).toMatchObject({ decision: "allow" });
      expect(await studio.check({ cwd, argv, env })).toMatchObject({ decision: "ask" });

      const cardsBefore = h.cards.length;
      const again = await build.inject(run.use("deploy-again"));
      expect(again.state).not.toBe("waiting");
      await vi.waitFor(() => expect(h.ended).toHaveLength(2));
      expect(h.cards).toHaveLength(cardsBefore);
      expect((await studio.inject(run.use("deploy-elsewhere"))).state).toBe("waiting");
      expect(await run.lines()).toEqual([TOKEN, TOKEN]);
    },
  );

  it(
    "a take the work route asks again after a dropped connection still starts the program, once",
    BUDGET,
    async () => {
      const h = home();
      await h.settings.put(INPUT);
      const dropped: Promise<unknown>[] = [];
      const there = workComputer(h.settings, BUILD_MAC, dropped);
      const run = await program();

      // The take waits for the approval while its first send is cut off.
      const asked = await there.inject(run.use("deploy-reconnect"));
      expect(asked.state).toBe("waiting");
      await vi.waitFor(() => expect(dropped).toHaveLength(1));
      await h.click(SECRETS_WORDS.once);
      await vi.waitFor(() => expect(h.ended).toHaveLength(1));
      expect(h.ended[0]?.receipt).toMatchObject({ state: "completed", exitCode: 0 });
      expect(await run.lines()).toEqual([TOKEN]);
      // The cut-off send was answered the same values, which went nowhere.
      expect(await dropped[0]).toHaveProperty("values");
    },
  );

  it(
    "a use whose values were taken ends unknown once its conversation there is gone",
    BUDGET,
    async () => {
      const h = home();
      await h.settings.put(INPUT);
      const context = { task: TASK, computer: BUILD_MAC };
      const there = workComputer(h.settings, BUILD_MAC);
      const cwd = await realpath(scratchDir("secrets-elsewhere-task-"));
      const stop = join(cwd, "stop");
      const started = join(cwd, "started");
      const script = join(cwd, "wait.sh");
      await writeFile(script, `: > '${started}'; while [ ! -f '${stop}' ]; do sleep 0.05; done\n`);
      const asked = await there.inject({
        id: "deploy-gone",
        reason: "Deploy the site",
        cwd,
        argv: ["/bin/sh", script],
        env: { DEPLOY_TOKEN: INPUT.ref },
      });
      // The home's Allow settles only once the use ends.
      const allowed = h.click(SECRETS_WORDS.once);
      // The program started with the values; another call cannot take them now.
      await vi.waitFor(async () => expect(await readFile(started, "utf8")).toBe(""), BUDGET);
      expect(await h.settings.take(context, asked.request, "another-call")).toEqual({
        state: "taken",
      });

      // The program never reports: its computer restarted, or its task closed there for good.
      h.settings.elsewhereGone({ task: "another-task", computer: BUILD_MAC.id });
      h.settings.elsewhereGone({ task: TASK, computer: OTHER_MAC.id });
      expect(h.ended).toEqual([]);
      h.settings.elsewhereGone({ task: TASK, computer: BUILD_MAC.id });
      await allowed;
      await vi.waitFor(() => expect(h.ended).toHaveLength(1));
      expect(h.ended[0]?.receipt.state).toBe("unknown");
      // A report that arrives after that changes nothing.
      const heard = vi.spyOn(h.settings, "elsewhere");
      await writeFile(stop, "");
      await vi.waitFor(() =>
        expect(heard.mock.calls.map(([, input]) => input.op)).toContain("ended"),
      );
      await heard.mock.results.at(-1)?.value;
      expect(h.ended).toHaveLength(1);
      expect(
        (await h.settings.view()).history.find((one) => one.request === asked.request)?.state,
      ).toBe("unknown");
    },
  );

  it(
    "a take left waiting by a computer that restarted spends nothing once its conversation is gone",
    BUDGET,
    async () => {
      const h = home();
      await h.settings.put(INPUT);
      const dropped: Promise<unknown>[] = [];
      const there = workComputer(h.settings, BUILD_MAC, dropped);
      const run = await program();

      const asked = await there.inject(run.use("deploy-restarted"));
      expect(asked.state).toBe("waiting");
      await vi.waitFor(() => expect(dropped).toHaveLength(1));
      // That computer restarted and forgot the take; the home hears it is back.
      h.settings.elsewhereGone({ task: TASK, computer: BUILD_MAC.id });
      expect(await dropped[0]).toEqual({ state: "unavailable" });
      await vi.waitFor(async () =>
        expect(
          (await h.settings.view()).uses.find((one) => one.request === asked.request)?.state,
        ).toBe("cancelled"),
      );
      // A press on the card it raised spends nothing, and the program never ran.
      expect(h.cards.at(-1)?.actions.some((action) => action.label === SECRETS_WORDS.once)).toBe(
        true,
      );
      await expect(h.click(SECRETS_WORDS.once)).resolves.toBeUndefined();
      expect(
        await h.settings.take({ task: TASK, computer: BUILD_MAC }, asked.request, "take-1"),
      ).toEqual({ state: "unavailable" });
      expect(await run.lines()).toEqual([]);
    },
  );

  it("two approvals at once run the program there once", BUDGET, async () => {
    const h = home();
    await h.settings.put(INPUT);
    // A second approver enrolled as a phone or a Mac is: a real P-256 key.
    const DEVICE = "1E0B6C1A-7A44-4C55-8F0B-2B9E3B6F4D21";
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const key = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    await h.settings.enroll({ device: DEVICE, label: "Studio Mac", key });
    await h.click(SECRET_DEVICE_WORDS.confirm);
    const there = workComputer(h.settings, BUILD_MAC);
    const run = await program();

    const asked = await there.inject(run.use("deploy-twice"));
    const card = h.cards.find((one) => one.id === `card-secrets-use-${asked.request}`);
    const approvals = await h.settings.approvals(DEVICE);
    const use = approvals.waiting.find((one) => one.request === asked.request);
    if (!use?.nonce || !approvals.home) throw new Error("No challenge for the enrolled device.");
    const signature = sign(
      "sha256",
      Buffer.from(
        decisionMessage({
          home: approvals.home,
          device: DEVICE,
          generation: 1,
          request: use.request,
          digest: use.digest,
          nonce: use.nonce,
          expires: use.expires,
        }),
      ),
      { key: pair.privateKey, dsaEncoding: "der" },
    ).toString("base64");

    await Promise.all([
      h.click(SECRETS_WORDS.once, card),
      h.settings.decideRemotely({
        kind: "allow",
        request: use.request,
        device: DEVICE,
        generation: 1,
        nonce: use.nonce,
        signature,
      }),
    ]);
    await vi.waitFor(() => expect(h.ended).toHaveLength(1));
    expect(h.ended[0]?.receipt.state).toBe("completed");
    expect(await run.lines()).toEqual([TOKEN]);
    expect(
      (await h.settings.view()).history.filter((one) => one.request === asked.request),
    ).toHaveLength(1);
  });
});
