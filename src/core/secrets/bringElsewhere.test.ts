import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import { secretBringRows } from "@shared/secretBring";
import {
  type PlacedSecretBringAnswer,
  type PlacedSecretBringInput,
  placedSecretBringAnswerSchema,
  placedSecretBringInputSchema,
} from "@shared/workSecrets";
import { describe, expect, it } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { SecretBringsThere } from "../helper/secretBrings";
import { hostEnv } from "../hostEnv";
import { type SecretBringEnded, type SecretBringRequest, SecretBrings } from "./bring";
import { SECRET_BRING_WORDS } from "./commandWords";
import { ProtectedSecrets } from "./protected";
import { SecretRequests } from "./requests";

// Intent: INF-4718's plan, piece 4, approved by the captain: "a way for users
// who have secrets stored in automic vault to easily migrate secrets into
// infinitary... we need to handle secrets safely not leaking it in plain text
// into unintended places". The tool is on a computer that runs work: the
// bring runs there, and the values cross once to the home over the
// authenticated work route. The home's bring owner and that computer's
// command are the real owners, joined only by the `inf:work:secret-bring`
// shapes the work route carries, each request and answer parsed as it would
// be and kept here to search. Custody is the disposable stand-in; the tools
// are real /bin/sh programs printing invented markers.
//
// Integration (docs/test-cohorts.md): each case starts at most two /bin/sh
// programs; a case took under 0.5 s on an Apple silicon Mac.
const BUDGET = { timeout: 15_000 };

const MARKER = "av_invented_marker_4734_there";
const OTHER = "av_invented_marker_4734_other";
const leaks = (text: string, marker = MARKER) =>
  text.includes(marker) || text.includes(Buffer.from(marker).toString("base64"));

const TASK = "task-there";
const BUILD_MAC = { id: "work-mac-1", label: "Build Mac" };
type Raised = Omit<Card, "author" | "priority" | "status" | "createdAt">;

/** A program as a password tool ships one; each run leaves one line in `runs`. */
function tool(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho ran >> '${join(dir, "runs")}'\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
const runs = (dir: string) =>
  existsSync(join(dir, "runs"))
    ? readFileSync(join(dir, "runs"), "utf8").split("\n").length - 1
    : 0;

async function fixture(options: { lifetimeMs?: number } = {}) {
  const dir = scratchDir("secret-brings-home-");
  // The other computer's own folder, where its tool is.
  const there = realpathSync(scratchDir("secret-brings-there-"));
  const owner = await ProtectedSecrets.open({
    dir: join(dir, "secrets"),
    custody: disposableCustody(),
    initialize: true,
    environment: () => hostEnv(),
    authentication: { available: async () => true, confirm: async () => true },
  });
  const cards: Raised[] = [];
  const heard: { task: string; ended: SecretBringEnded }[] = [];
  const brings = new SecretBrings({
    owner: async () => owner,
    offered: true,
    environment: () => hostEnv(),
    raise: (card) => {
      cards.push(card);
    },
    withdraw: () => {},
    changed: () => {},
    brought: (task, ended) => {
      heard.push({ task, ended });
    },
    taskOpen: () => true,
    taskTitle: () => "Move the build Mac's keys",
    ...(options.lifetimeMs ? { lifetimeMs: options.lifetimeMs } : {}),
  });
  /** Every request and answer the work route carried, as JSON, in order. */
  const route: { input: PlacedSecretBringInput; answer: PlacedSecretBringAnswer }[] = [];
  const command = new SecretBringsThere({
    environment: () => hostEnv(),
    home: async (input) => {
      const sent = placedSecretBringInputSchema.parse(JSON.parse(JSON.stringify(input)));
      const answer = placedSecretBringAnswerSchema.parse(
        JSON.parse(JSON.stringify(await brings.elsewhere(TASK, BUILD_MAC, sent))),
      );
      route.push({ input: sent, answer });
      return answer;
    },
  });
  const offer = () => {
    const card = cards.at(-1);
    const found = card && secretBringRows({ ...card, author: "host" });
    if (!found) throw new Error("The card offers no rows.");
    return found;
  };
  const press = async (label: string) => {
    const effect = cards.at(-1)?.actions.find((action) => action.label === label)?.effect;
    if (effect?.kind !== "host" || effect.op !== "secrets-decision" || !effect.arg)
      throw new Error(`No ${label} on the card.`);
    await brings.decide(effect.arg);
  };
  /** Runs a checker on the home with the kept secret under an approved injection: exit 0 when it got the marker. */
  const delivered = async (ref: string, marker = MARKER) => {
    // Outside the home's Secrets folder, which `saved` searches for the marker.
    const checks = scratchDir("secret-brings-check-");
    const check = join(checks, "check.sh");
    writeFileSync(check, `#!/bin/sh\n[ "$GOT" = '${marker}' ] && exit 0; exit 3\n`);
    chmodSync(check, 0o755);
    const requests = new SecretRequests(owner);
    const receipt = await requests.inject({
      id: `check-${ref}`,
      reason: "Check the brought value arrives",
      env: { GOT: ref },
      argv: [check],
      cwd: checks,
    });
    const pending = requests.pending(receipt.request);
    if (!pending) throw new Error("The check was not waiting.");
    const proof = await owner.confirmUse(receipt.request, pending.digest, pending.expires, "Check");
    await requests.approve(receipt.request, proof);
    return requests.status(receipt.request);
  };
  /** Every saved file of the home's Secrets, read as bytes. */
  const saved = () => {
    const files: string[] = [];
    const walk = (at: string) => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const path = join(at, entry.name);
        if (entry.isDirectory()) walk(path);
        else files.push(readFileSync(path).toString("latin1"));
      }
    };
    walk(dir);
    return files.join("\n");
  };
  /** Waits until the follower on that computer has asked `next` and stopped. */
  const settled = async () => {
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    there,
    owner,
    cards,
    heard,
    brings,
    route,
    command,
    offer,
    press,
    delivered,
    saved,
    settled,
  };
}

function bring(
  source: SecretBringRequest["from"]["source"],
  more: Partial<SecretBringRequest["from"]> = {},
  id = "build-keys",
): SecretBringRequest {
  return {
    id,
    reason: "Move the deploy keys out of Automic Vault on the build Mac",
    from: { tool: "Automic Vault", source, reads: "env0", ...more },
  };
}

const deliveries = (route: { input: PlacedSecretBringInput }[]) =>
  route.flatMap(({ input }) => (input.op === "deliver" ? [input] : []));

describe("bringing secrets from a tool on a computer that runs work", () => {
  it(
    "runs the tool there on the captain's press and sends only the ticked value, once",
    BUDGET,
    async () => {
      const f = await fixture();
      const av = tool(
        f.there,
        "av",
        `printf 'PATH=/usr/bin\\0DEPLOY_TOKEN=${MARKER}\\0SIGNING_KEY=${OTHER}\\0'; echo '${MARKER}' >&2`,
      );
      const started = await f.command.bring(
        bring(
          { run: [av, "inject", "+DEPLOY_TOKEN", "+SIGNING_KEY"], folder: f.there },
          { secrets: [{ name: "DEPLOY_TOKEN", place: "Release" }, { name: "SIGNING_KEY" }] },
        ),
      );
      expect(started).toEqual({ bring: "build-keys", state: "waiting" });
      // The card is the home's own, naming the computer, the exact command and its folder.
      const card = f.cards.at(-1);
      expect(card?.title).toBe("Bring 2 secrets from Automic Vault?");
      expect(card?.body).toContain(">Build Mac</span>");
      expect(card?.body).toContain(`${av} inject +DEPLOY_TOKEN +SIGNING_KEY`);
      expect(card?.body).toContain(f.there);
      await f.settled();
      expect(runs(f.there)).toBe(0);

      const { pass, rows } = f.offer();
      expect(await f.brings.bringInto({ pass, picked: [rows[0]?.id ?? ""] })).toEqual({
        brought: true,
      });
      expect(runs(f.there)).toBe(1);
      const sent = deliveries(f.route);
      expect(sent).toHaveLength(1);
      // Only the ticked name crossed: the unticked value and the base variables stayed there.
      expect(sent[0]?.result).toEqual({
        values: { DEPLOY_TOKEN: { value: Buffer.from(MARKER).toString("base64") } },
      });
      const ended = f.heard[0]?.ended;
      if (ended?.state !== "kept") throw new Error(`Not kept: ${ended?.state}`);
      expect(ended.secrets.map(({ name, place, outcome }) => [name, place, outcome])).toEqual([
        ["DEPLOY_TOKEN", "Release", "kept"],
        ["SIGNING_KEY", "", "skipped"],
      ]);
      expect(await f.delivered(ended.secrets[0]?.ref ?? "")).toMatchObject({
        state: "completed",
        exitCode: 0,
      });
      expect(f.owner.history().find((item) => item.brought)).toMatchObject({
        brought: "Automic Vault",
        computer: "Build Mac",
        program: av,
      });
      // The value is nowhere but the one delivery and the sealed store.
      const others = f.route.filter(({ input }) => input.op !== "deliver");
      const shown = JSON.stringify({
        cards: f.cards,
        heard: f.heard,
        history: f.owner.history(),
        others,
        answers: f.route.map(({ answer }) => answer),
      });
      expect(leaks(shown)).toBe(false);
      expect(leaks(JSON.stringify(f.route), OTHER)).toBe(false);
      expect(leaks(f.saved())).toBe(false);
      await f.settled();
      expect(f.route.at(-1)?.answer).toEqual({ over: true });
    },
  );

  it(
    "reads a .env file there once for its names and keeps the ticked one without reading again",
    BUDGET,
    async () => {
      const f = await fixture();
      const env = join(f.there, ".env");
      writeFileSync(env, `# deploy\nDEPLOY_TOKEN=${MARKER}\nexport SIGNING_KEY="${OTHER}"\n`);
      await f.command.bring(bring({ file: env }, { reads: "lines" }));
      expect(f.cards.at(-1)?.title).toBe("Read secrets from Automic Vault?");
      await f.press("Read it");
      const { pass, rows } = f.offer();
      expect(rows.map((row) => [row.name, row.ticked])).toEqual([
        ["DEPLOY_TOKEN", true],
        ["SIGNING_KEY", true],
      ]);
      await f.brings.bringInto({ pass, picked: [rows[0]?.id ?? ""] });
      // The read sent every name it found once; the press used what the home held.
      expect(deliveries(f.route)).toHaveLength(1);
      const ended = f.heard[0]?.ended;
      if (ended?.state !== "kept") throw new Error(`Not kept: ${ended?.state}`);
      expect(ended.secrets.map(({ name, outcome }) => [name, outcome])).toEqual([
        ["DEPLOY_TOKEN", "kept"],
        ["SIGNING_KEY", "skipped"],
      ]);
      expect(await f.delivered(ended.secrets[0]?.ref ?? "")).toMatchObject({ exitCode: 0 });
      expect((await f.owner.metadata()).map((entry) => entry.label)).toEqual(["DEPLOY_TOKEN"]);
      expect(readFileSync(env, "utf8")).toContain(MARKER);
    },
  );

  it("refuses unlock keys there before asking the home", BUDGET, async () => {
    const f = await fixture();
    const av = tool(f.there, "av", "exit 0");
    const answer = await f.command.bring(
      bring({ run: [av], folder: f.there }, { secrets: [{ name: "A" }], uses: { KEY: "unlock" } }),
    );
    expect(answer).toEqual({
      bring: "build-keys",
      state: "unavailable",
      help: SECRET_BRING_WORDS.usesNotThere,
    });
    expect(f.route).toHaveLength(0);
    expect(f.cards).toHaveLength(0);
  });

  it(
    "ends changed, keeping nothing, when the tool there changed after the card",
    BUDGET,
    async () => {
      const f = await fixture();
      const av = tool(f.there, "av", `printf 'DEPLOY_TOKEN=${MARKER}\\0'`);
      await f.command.bring(
        bring({ run: [av], folder: f.there }, { secrets: [{ name: "DEPLOY_TOKEN" }] }),
      );
      tool(f.there, "av", `printf 'DEPLOY_TOKEN=${OTHER}\\0'`);
      const { pass } = f.offer();
      await f.brings.bringInto({ pass, picked: ["s1"] });
      expect(f.heard[0]?.ended).toEqual({ bring: "build-keys", state: "changed" });
      expect(runs(f.there)).toBe(0);
      expect(deliveries(f.route)[0]?.result).toEqual({ ended: "changed" });
      expect(await f.owner.metadata()).toEqual([]);
    },
  );

  it(
    "runs nothing there after Don't bring, a withdrawal or a gone conversation",
    BUDGET,
    async () => {
      const f = await fixture();
      const av = tool(f.there, "av", `printf 'DEPLOY_TOKEN=${MARKER}\\0'`);
      const from = (id: string) =>
        bring({ run: [av], folder: f.there }, { secrets: [{ name: "DEPLOY_TOKEN" }] }, id);

      await f.command.bring(from("dont"));
      await f.press("Don't bring");
      await f.command.bring(from("cancel"));
      expect(await f.command.cancelBring("cancel")).toBe(true);
      await f.command.bring(from("gone"));
      f.brings.gone(TASK, BUILD_MAC);
      await f.settled();

      expect(f.heard.map(({ ended }) => ended)).toEqual([
        { bring: "dont", state: "not-brought" },
        { bring: "gone", state: "withdrawn", why: SECRET_BRING_WORDS.gone },
      ]);
      expect(await f.command.bringStatus("cancel")).toEqual({
        bring: "cancel",
        state: "withdrawn",
        why: SECRET_BRING_WORDS.cancelled,
      });
      expect(runs(f.there)).toBe(0);
      expect(deliveries(f.route)).toHaveLength(0);
      // Each follower there heard its bring end.
      expect(f.route.filter(({ answer }) => "over" in answer)).toHaveLength(3);
    },
  );

  it("ends failed when the computer there never runs the press", BUDGET, async () => {
    const f = await fixture({ lifetimeMs: 200 });
    const answer = await f.brings.elsewhere(TASK, BUILD_MAC, {
      op: "bring",
      id: "silent",
      reason: "Move the deploy keys",
      from: { tool: "Automic Vault", reads: "env0", secrets: [{ name: "DEPLOY_TOKEN" }] },
      source: {
        kind: "run",
        program: { path: "/usr/bin/env", sha256: "0".repeat(64) },
        argv: ["env", "-0"],
        folder: "/",
      },
    });
    expect(answer).toEqual({ bring: { bring: "silent", state: "waiting" } });
    const { pass } = f.offer();
    await f.brings.bringInto({ pass, picked: ["s1"] });
    expect(f.heard[0]?.ended).toEqual({
      bring: "silent",
      state: "failed",
      why: SECRET_BRING_WORDS.unreached,
    });
    expect(await f.owner.metadata()).toEqual([]);
  });
});
