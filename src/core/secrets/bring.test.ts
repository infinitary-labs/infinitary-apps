import { chmodSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import { secretBringRows } from "@shared/secretBring";
import { afterEach, describe, expect, it, vi } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { hostEnv } from "../hostEnv";
import { type SecretBringEnded, type SecretBringRequest, SecretBrings } from "./bring";
import { SECRET_BRING_WORDS } from "./commandWords";
import { ProtectedSecrets } from "./protected";
import { SecretRequests } from "./requests";

// Intent: INF-4718's plan, piece 1, approved by the captain: "a way for users
// who have secrets stored in automic vault to easily migrate secrets into
// infinitary... using agents is allowed but we need to handle secrets safely
// not leaking it in plain text into unintended places". A crewmate names the
// tool's command or file and the names; Infinitary's own card asks; on the
// captain's press Infinitary runs or reads it itself and keeps only the
// ticked values. The asker hears names, references and outcomes, never a
// value. Stand-in programs print invented markers in each shape the plan
// reads; custody is the disposable stand-in, the programs are real.
//
// Integration (docs/test-cohorts.md): each case starts real programs, the
// stand-in tool and a checker run through an approved injection. A case took
// 0.1-0.4 s on an Apple silicon Mac; the budget leaves room for a loaded
// Linux check.
const BUDGET = { timeout: 15_000 };

const MARKER = "av_invented_marker_4718_value";
const OTHER = "av_invented_marker_4718_other";
const leaks = (text: string, marker = MARKER) =>
  text.includes(marker) || text.includes(Buffer.from(marker).toString("base64"));

type Raised = Omit<Card, "author" | "priority" | "status" | "createdAt">;

/** A program as a password tool ships one: prints what it holds and exits. */
function tool(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function fixture(
  options: {
    offered?: boolean;
    file?: string;
    lifetimeMs?: number;
    confirm?: () => Promise<boolean>;
  } = {},
) {
  const dir = scratchDir("secret-brings-");
  const store = join(dir, "secrets");
  const project = realpathSync(scratchDir("secret-bring-project-"));
  const owner = await ProtectedSecrets.open({
    dir: store,
    custody: disposableCustody(),
    initialize: true,
    environment: () => hostEnv({ AWS_SECRET_ACCESS_KEY: "inherited-invented-aws-key" }),
    authentication: { available: async () => true, confirm: options.confirm ?? (async () => true) },
  });
  const cards: Raised[] = [];
  const withdrawn: string[] = [];
  const heard: { task: string; ended: SecretBringEnded }[] = [];
  const make = () =>
    new SecretBrings({
      owner: async () => owner,
      offered: options.offered ?? true,
      environment: () => hostEnv({ AWS_SECRET_ACCESS_KEY: "inherited-invented-aws-key" }),
      raise: (card) => {
        cards.push(card);
      },
      withdraw: (id) => {
        withdrawn.push(id);
      },
      changed: () => {},
      brought: (task, ended) => {
        heard.push({ task, ended });
      },
      taskOpen: () => true,
      taskTitle: () => "Deploy the staging site",
      ...(options.file ? { file: options.file } : {}),
      ...(options.lifetimeMs ? { lifetimeMs: options.lifetimeMs } : {}),
    });
  const brings = make();
  const command = brings.commandFor("task-a");
  /** The newest card's Bring into Secrets, read as the window reads it. */
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
  /** Runs a checker with the kept secret under an approved injection: exit 0 when it got the marker. */
  const delivered = async (ref: string, marker = MARKER) => {
    const check = tool(project, "check.sh", `[ "$GOT" = '${marker}' ] && exit 0; exit 3`);
    const requests = new SecretRequests(owner);
    const receipt = await requests.inject({
      id: `check-${ref}-${Math.random().toString(36).slice(2)}`,
      reason: "Check the brought value arrives",
      env: { GOT: ref },
      argv: [check],
      cwd: project,
    });
    const pending = requests.pending(receipt.request);
    if (!pending) throw new Error("The check was not waiting.");
    const proof = await owner.confirmUse(receipt.request, pending.digest, pending.expires, "Check");
    await requests.approve(receipt.request, proof);
    return requests.status(receipt.request);
  };
  /** Every saved file of Secrets, read as bytes: no marker plain or base64. */
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
  return {
    dir,
    project,
    owner,
    cards,
    withdrawn,
    heard,
    brings,
    make,
    command,
    offer,
    press,
    delivered,
    saved,
  };
}

function bring(
  source: SecretBringRequest["from"]["source"],
  more: Partial<SecretBringRequest["from"]> = {},
  id = "av",
): SecretBringRequest {
  return {
    id,
    reason: "Move the staging keys out of Automic Vault",
    from: { tool: "Automic Vault", source, reads: "env0", ...more },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bringing secrets from another tool", () => {
  it(
    "runs the tool's command itself on the captain's press and keeps only the ticked values",
    BUDGET,
    async () => {
      const f = await fixture();
      // As `av inject ... -- /usr/bin/env -0` prints: the tool's entries among the base ones.
      const av = tool(
        f.project,
        "av",
        `printf 'PATH=/usr/bin\\0STAGING_TOKEN=${MARKER}\\nsecond line\\0DB_PASSWORD=${OTHER}\\0'; echo '${MARKER}' >&2`,
      );
      const started = await f.command.bring(
        bring(
          { run: [av, "inject", "staging"] },
          {
            secrets: [
              { name: "STAGING_TOKEN", as: "Staging token", place: "Staging" },
              { name: "DB_PASSWORD", place: "Staging" },
            ],
          },
        ),
      );
      expect(started).toEqual({ bring: "av", state: "waiting" });
      const card = f.cards.at(-1);
      expect(card?.title).toBe("Bring 2 secrets from Automic Vault?");
      expect(card?.taskId).toBe("task-a");
      // INF-6265 piece 1: the card names the task, whose crewmate answers its thread.
      expect(card?.meta).toBe("Deploy the staging site");
      expect(card?.answeredBy).toBe("crewmate");
      expect(card?.body).toContain(`${realpathSync(av)} inject staging`);
      const { pass, rows } = f.offer();
      expect(rows.map((row) => [row.name, row.place, row.ticked])).toEqual([
        ["Staging token", "Staging", true],
        ["DB_PASSWORD", "Staging", true],
      ]);
      expect(await f.brings.bringInto({ pass, picked: [rows[0]?.id ?? ""] })).toEqual({
        brought: true,
      });
      expect(f.heard).toHaveLength(1);
      const ended = f.heard[0]?.ended;
      if (ended?.state !== "kept") throw new Error(`Not kept: ${ended?.state}`);
      expect(ended.secrets.map(({ name, outcome, version }) => [name, outcome, version])).toEqual([
        ["Staging token", "kept", 1],
        ["DB_PASSWORD", "skipped", undefined],
      ]);
      expect(f.withdrawn).toContain(card?.id);
      const ref = ended.secrets[0]?.ref ?? "";
      // A value over two lines arrives exactly as the tool printed it.
      expect(await f.delivered(ref, `${MARKER}\nsecond line`)).toMatchObject({
        state: "completed",
        exitCode: 0,
      });
      expect((await f.owner.metadata()).map((entry) => [entry.label, entry.environment])).toEqual([
        ["Staging token", "Staging"],
      ]);
      expect(f.owner.history().find((item) => item.brought)).toMatchObject({
        brought: "Automic Vault",
        program: realpathSync(av),
        state: "completed",
        exitCode: 0,
      });
      // The value is nowhere but the sealed store: not on the card, in the inbox, the history or a saved file.
      const shown = JSON.stringify({ cards: f.cards, heard: f.heard, history: f.owner.history() });
      expect(leaks(shown)).toBe(false);
      expect(leaks(shown, OTHER)).toBe(false);
      expect(leaks(f.saved())).toBe(false);
      expect(leaks(f.saved(), OTHER)).toBe(false);
      // A spent pass does nothing.
      expect(await f.brings.bringInto({ pass, picked: [] })).toEqual({
        brought: false,
        words: expect.any(String),
      });
      expect(f.heard).toHaveLength(1);
    },
  );

  it("brings an already-kept name unticked, and replaces it only when ticked", BUDGET, async () => {
    const f = await fixture();
    await f.owner.putSecret("staging-token", "Staging token", Buffer.from("old-invented"), {
      discoverable: true,
    });
    const av = tool(f.project, "av", `printf '%s\\n' '${MARKER}'`);
    await f.command.bring(
      bring(
        { run: [av, "get", "staging-token"] },
        { reads: "value", trim: "newline", secrets: [{ name: "token", as: "Staging token" }] },
      ),
    );
    const { pass, rows } = f.offer();
    expect(rows).toEqual([
      expect.objectContaining({
        name: "Staging token",
        source: "token",
        ticked: false,
        replaces: { ref: "staging-token", version: 1 },
      }),
    ]);
    await f.brings.bringInto({ pass, picked: [rows[0]?.id ?? ""] });
    const ended = f.heard[0]?.ended;
    if (ended?.state !== "kept") throw new Error("Not kept.");
    expect(ended.secrets).toEqual([
      { name: "Staging token", place: "", outcome: "kept", ref: "staging-token", version: 2 },
    ]);
    expect(await f.delivered("staging-token")).toMatchObject({ exitCode: 0 });

    // A secret changed after the card showed it is left alone, and its row says so.
    await f.command.bring(
      bring(
        { run: [av, "get", "staging-token"] },
        { reads: "value", trim: "newline", secrets: [{ name: "token", as: "Staging token" }] },
        "again",
      ),
    );
    const stale = f.offer();
    await f.owner.putSecret("staging-token", "Staging token", Buffer.from("newer-invented"), {
      discoverable: true,
    });
    await f.brings.bringInto({ pass: stale.pass, picked: [stale.rows[0]?.id ?? ""] });
    expect(f.heard[1]?.ended).toMatchObject({
      state: "kept",
      secrets: [{ name: "Staging token", outcome: "changed" }],
    });
    expect((await f.owner.metadata())[0]?.version).toBe(3);
    expect(await f.delivered("staging-token", "newer-invented")).toMatchObject({ exitCode: 0 });
  });

  it(
    "reads a .env file first when no names are given, then keeps the picked ones",
    BUDGET,
    async () => {
      const f = await fixture();
      const env = join(f.project, ".env");
      writeFileSync(env, `# staging\nexport API_KEY=${MARKER}\nEMPTY=\nOTHER_KEY="${OTHER}"\n`);
      await f.command.bring({
        id: "dotenv",
        reason: "Keep the project's .env keys in Secrets",
        from: { tool: ".env file", source: { file: env }, reads: "lines" },
      });
      expect(f.cards.at(-1)?.title).toBe("Read secrets from .env file?");
      expect(f.cards.at(-1)?.actions.map((action) => action.label)).toEqual([
        "Don't bring",
        "Read it",
      ]);
      await f.press("Read it");
      const { pass, rows } = f.offer();
      expect(rows.map((row) => [row.name, row.ticked, row.cannot])).toEqual([
        ["API_KEY", true, undefined],
        ["EMPTY", false, "empty"],
        ["OTHER_KEY", true, undefined],
      ]);
      expect(leaks(JSON.stringify(f.cards))).toBe(false);
      expect(await f.brings.bringInto({ pass, picked: [rows[1]?.id ?? ""] })).toMatchObject({
        brought: false,
      });
      const again = f.offer();
      await f.brings.bringInto({ pass: again.pass, picked: [rows[0]?.id ?? ""] });
      const ended = f.heard[0]?.ended;
      if (ended?.state !== "kept") throw new Error("Not kept.");
      expect(ended.secrets.map(({ name, outcome }) => [name, outcome])).toEqual([
        ["API_KEY", "kept"],
        ["EMPTY", "skipped"],
        ["OTHER_KEY", "skipped"],
      ]);
      expect(await f.delivered(ended.secrets[0]?.ref ?? "")).toMatchObject({ exitCode: 0 });
      // What happened lists the read, which kept nothing, and then the bring.
      expect(
        f.owner
          .history()
          .filter((item) => item.brought)
          .map((item) => [item.program, item.secrets.length, item.state]),
      ).toEqual([
        [env, 0, "completed"],
        [env, 1, "completed"],
      ]);
      expect(leaks(f.saved(), OTHER)).toBe(false);
    },
  );

  it(
    "lets go of what a read holds on Don't bring, and leaves the file as it was",
    BUDGET,
    async () => {
      const f = await fixture();
      const env = join(f.project, ".env");
      const text = `API_KEY=${MARKER}\nMULTI="first\nsecond"\n`;
      writeFileSync(env, text);
      await f.command.bring({
        id: "dotenv",
        reason: "Keep the project's .env keys in Secrets",
        from: { tool: ".env file", source: { file: env }, reads: "lines" },
      });
      await f.press("Read it");
      expect(f.offer().rows.map((row) => row.name)).toEqual(["API_KEY", "MULTI"]);
      await f.press("Don't bring");
      expect(f.heard.at(-1)?.ended).toEqual({ bring: "dotenv", state: "not-brought" });
      expect((f.brings as unknown as { held: Map<string, unknown> }).held.size).toBe(0);
      expect(await f.owner.metadata()).toEqual([]);
      expect(readFileSync(env, "utf8")).toBe(text);
      expect(leaks(JSON.stringify({ cards: f.cards, heard: f.heard })) || leaks(f.saved())).toBe(
        false,
      );
    },
  );

  it("runs nothing when the program changed after the card showed it", BUDGET, async () => {
    const f = await fixture();
    const runs = join(f.project, "runs.log");
    const av = tool(f.project, "av", `printf 'A=${MARKER}\\0'`);
    await f.command.bring(bring({ run: [av] }, { secrets: [{ name: "A" }] }));
    tool(f.project, "av", `echo ran >> '${runs}'; printf 'A=${OTHER}\\0'`);
    const { pass, rows } = f.offer();
    await f.brings.bringInto({ pass, picked: [rows[0]?.id ?? ""] });
    expect(f.heard[0]?.ended).toEqual({ bring: "av", state: "changed" });
    expect(() => readFileSync(runs)).toThrow();
    expect(await f.owner.metadata()).toEqual([]);
  });

  it("says a failing tool failed with only its exit code, never its output", BUDGET, async () => {
    const f = await fixture();
    const av = tool(f.project, "av", `echo '${MARKER}'; echo '${MARKER}' >&2; exit 3`);
    await f.command.bring(bring({ run: [av] }, { secrets: [{ name: "A" }] }));
    const { pass, rows } = f.offer();
    await f.brings.bringInto({ pass, picked: [rows[0]?.id ?? ""] });
    expect(f.heard[0]?.ended).toEqual({
      bring: "av",
      state: "failed",
      exitCode: 3,
      why: SECRET_BRING_WORDS.failed,
    });
    expect(f.command.bringStatus("av")).toEqual(f.heard[0]?.ended);
    expect(await f.owner.metadata()).toEqual([]);
    expect(f.owner.history().at(-1)).toMatchObject({ brought: "Automic Vault", exitCode: 3 });
    expect(leaks(JSON.stringify(f.heard)) || leaks(f.saved())).toBe(false);
  });

  it(
    "ends a press whose tool left a process holding its output, at the time limit",
    BUDGET,
    async () => {
      const f = await fixture({ lifetimeMs: 1_000 });
      const left = join(f.project, "left.pid");
      const av = tool(f.project, "av", `printf 'A=${MARKER}\\0'; sleep 30 & echo $! > '${left}'`);
      await f.command.bring(bring({ run: [av] }, { secrets: [{ name: "A" }] }));
      const { pass, rows } = f.offer();
      try {
        await f.brings.bringInto({ pass, picked: [rows[0]?.id ?? ""] });
        expect(f.heard[0]?.ended).toMatchObject({ bring: "av", state: "failed" });
        expect(await f.owner.metadata()).toEqual([]);
      } finally {
        process.kill(Number(readFileSync(left, "utf8")), "SIGKILL");
      }
    },
  );

  it(
    "raises no second card while a press runs, so nothing can end it beside the press",
    BUDGET,
    async () => {
      const f = await fixture();
      const [started, go] = [join(f.project, "started"), join(f.project, "go")];
      const av = tool(
        f.project,
        "av",
        `: > '${started}'; while [ ! -e '${go}' ]; do sleep 0.05; done; printf 'A=${MARKER}\\0'`,
      );
      await f.command.bring(bring({ run: [av] }, { secrets: [{ name: "A" }] }));
      const raised = f.cards.length;
      const { pass, rows } = f.offer();
      const pressed = f.brings.bringInto({ pass, picked: [rows[0]?.id ?? ""] });
      await vi.waitFor(() => readFileSync(started));
      expect(await f.command.bring(bring({ run: [av] }, { secrets: [{ name: "A" }] }))).toEqual({
        bring: "av",
        state: "waiting",
      });
      expect(f.cards).toHaveLength(raised);
      writeFileSync(go, "");
      await pressed;
      expect(f.heard.map((one) => one.ended.state)).toEqual(["kept"]);
    },
  );

  it("refuses a program it cannot find, and anything outside the closed shape", async () => {
    const f = await fixture();
    expect(
      await f.command.bring(bring({ run: ["no-such-tool-4718"] }, { secrets: [{ name: "A" }] })),
    ).toEqual({ bring: "av", state: "unavailable", help: SECRET_BRING_WORDS.refused.program });
    await expect(
      f.command.bring({
        ...bring({ run: ["/bin/sh"] }, { secrets: [{ name: "A" }] }),
        value: MARKER,
      } as SecretBringRequest),
    ).rejects.toThrow("Invalid bring.");
    await expect(
      f.command.bring(bring({ run: ["/bin/sh"] }, { reads: "value", secrets: [] })),
    ).rejects.toThrow("Invalid bring.");
    expect(f.cards).toEqual([]);
  });

  it("is unavailable where Secrets is not offered", async () => {
    const f = await fixture({ offered: false });
    expect(
      await f.command.bring(bring({ run: ["/bin/sh"] }, { secrets: [{ name: "A" }] })),
    ).toEqual({ bring: "av", state: "unavailable", help: SECRET_BRING_WORDS.notOffered });
  });

  it("ends on Don't bring, on cancel and at expiry, and after a restart", BUDGET, async () => {
    const file = join(scratchDir("secret-brings-book-"), "secret-brings.json");
    const f = await fixture({ file, lifetimeMs: 60_000 });
    const av = tool(f.project, "av", `printf 'A=${MARKER}\\0'`);
    const ask = (id: string) =>
      f.command.bring(bring({ run: [av] }, { secrets: [{ name: "A" }] }, id));

    await ask("dont");
    await f.press("Don't bring");
    expect(f.heard.at(-1)?.ended).toEqual({ bring: "dont", state: "not-brought" });

    await ask("cancelled");
    const heard = f.heard.length;
    expect(f.command.cancelBring("cancelled")).toBe(true);
    expect(f.command.bringStatus("cancelled")).toMatchObject({ state: "withdrawn" });
    // The canceller hears its own answer; the inbox gets nothing more.
    expect(f.heard).toHaveLength(heard);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await ask("expires");
    vi.advanceTimersByTime(60_001);
    expect(f.heard.at(-1)?.ended).toEqual({ bring: "expires", state: "expired" });
    vi.useRealTimers();

    await ask("restart");
    const { pass } = f.offer();
    expect(readFileSync(file, "utf8")).not.toContain(MARKER);
    const after = f.make();
    after.resume();
    expect(f.heard.at(-1)?.ended).toEqual({ bring: "restart", state: "expired" });
    // The pass from before the restart is spent with its process.
    expect(await after.bringInto({ pass, picked: [] })).toMatchObject({ brought: false });
    expect(await f.owner.metadata()).toEqual([]);
  });
});

describe("named JSON bring with a kept unlock key", () => {
  it(
    "confirms once before launch, keeps only the named value and exposes no output",
    BUDGET,
    async () => {
      const confirm = vi.fn(async () => true);
      const f = await fixture({ confirm });
      await f.owner.putSecret("unlock", "Test unlock", Buffer.from(OTHER), { discoverable: true });
      // The stand-in echoes the input into a named field so an approved checker
      // proves the exact value made it through the child and the JSON reader.
      const program = tool(
        f.project,
        "export-json",
        `test -n "$VAULT_SESSION" || exit 4
printf '{"login":"%s","ignored":"%s"}' "$VAULT_SESSION" "$VAULT_SESSION"
printf '%s' "$VAULT_SESSION" >&2`,
      );
      const input: SecretBringRequest = {
        id: "json-bring",
        reason: "Move a named login",
        from: {
          tool: "Test vault",
          source: { run: [program], folder: f.project },
          reads: "json",
          secrets: [{ name: "login" }, { name: "absent" }],
          uses: { VAULT_SESSION: "unlock" },
        },
      };
      expect(await f.command.bring(input)).toEqual({ bring: input.id, state: "waiting" });
      expect(confirm).not.toHaveBeenCalled();
      expect(f.cards.at(-1)?.body).toContain("VAULT_SESSION");
      const { pass } = f.offer();
      const presses = await Promise.all([
        f.brings.bringInto({ pass, picked: ["s1", "s2"] }),
        f.brings.bringInto({ pass, picked: ["s1", "s2"] }),
      ]);
      expect(presses.filter((one) => one.brought)).toHaveLength(1);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(f.heard.map(({ ended }) => ended)).toEqual([
        {
          bring: input.id,
          state: "kept",
          secrets: [
            { name: "login", place: "", outcome: "kept", ref: "login", version: 1 },
            { name: "absent", place: "", outcome: "not-found" },
          ],
        },
      ]);
      expect(
        [f.saved(), JSON.stringify(f.cards), JSON.stringify(f.heard)].some((text) =>
          leaks(text, OTHER),
        ),
      ).toBe(false);
      expect((await f.delivered("login", OTHER))?.exitCode).toBe(0);
    },
  );

  it.each(["declined", "replaced"])(
    "does not launch when confirmation is %s",
    BUDGET,
    async (why) => {
      const f = await fixture({ confirm: async () => false });
      await f.owner.putSecret("unlock", "Test unlock", Buffer.from(OTHER), { discoverable: true });
      const program = tool(
        f.project,
        "export-json",
        `touch ran; printf '{"login":"%s"}' "$VAULT_SESSION"`,
      );
      const input: SecretBringRequest = {
        id: "no-bring",
        reason: "Move a named login",
        from: {
          tool: "Test vault",
          source: { run: [program], folder: f.project },
          reads: "json",
          secrets: [{ name: "login" }],
          uses: { VAULT_SESSION: "unlock" },
        },
      };
      expect((await f.command.bring(input)).state).toBe("waiting");
      if (why === "replaced")
        await f.owner.putSecret("unlock", "Test unlock", Buffer.from(MARKER), {
          discoverable: true,
        });
      await f.brings.bringInto({ pass: f.offer().pass, picked: ["s1"] });
      expect((await f.command.bringStatus(input.id))?.state).toBe(
        why === "replaced" ? "changed" : "not-brought",
      );
      expect(readdirSync(f.project)).not.toContain("ran");
    },
  );
});
