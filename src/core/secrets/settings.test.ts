import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { cp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import { secretName } from "@shared/secretNames";
import {
  decisionWords,
  SAVED_DECISION_WORDS,
  SECRET_APPROVAL_CARD_WORDS,
  SECRET_DEVICE_WORDS,
  SECRET_QUESTION_WORDS,
  SECRETS_RECOVERY_WORDS,
  SECRETS_WORDS,
  type SecretEntryInput,
  type SecretsView,
  secretApprovalsSchema,
  secretsNamed,
  secretsViewSchema,
} from "@shared/secrets";
import { describe, expect, it, vi } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { asAView } from "../askedFromAView";
import type { HostSecretsRecovery } from "../host";
import { approvalCode, decisionMessage } from "./approvals";
import { httpSecretBroker } from "./httpBroker";
import { ProtectedSecrets } from "./protected";
import { SHORT_READ_USES } from "./readAccess";
import type { RecoveryFiles } from "./recoveryArchive";
import { type EndedUseReceipt, SECRET_REQUEST_LIFETIME_MS } from "./requests";
import { SecretsSettings } from "./settings";

// Intent: INF-1109's trusted Settings controls and INF-30's selections: secure
// entry, metadata-only views, exact-use/rule confirmation, global discovery
// (the captain on INF-1109: "remove the discovery link concept altogether. it
// should just be global discovery"), bounded reads, End access and history
// kept until the captain deletes it.
// Native custody/authentication are explicit stand-ins; this proves controller
// behavior, never a platform store or a person's live system confirmation.
const TOKEN = "ya29.invented-calendar-settings-token";
const INPUT = {
  ref: "calendar",
  label: "Planning calendar",
  value: TOKEN,
  expectedVersion: 0,
  expectedRevision: null,
  environment: "Personal",
} satisfies SecretEntryInput;
type Raised = Omit<Card, "author" | "priority" | "status" | "createdAt">;
/** The tasks the fixture's home knows by title; any other task id is one it no longer knows. */
const TASK_TITLES: Record<string, string> = {
  "task-a": "Check the planning calendar",
  "task-b": "Plan the week",
  "planning-task": "Plan next week's meetings",
  "deploy-task": "Deploy the site",
};
const CALENDAR = secretsNamed([INPUT.label]);

function fixture() {
  const custody = disposableCustody();
  const dir = scratchDir("secrets-settings-");
  const cards: Raised[] = [];
  const withdrawn: string[] = [];
  const ended: { task: string; receipt: EndedUseReceipt }[] = [];
  let confirmation = true;
  let confirms = 0;
  let now = 1000;
  const sent: string[] = [];
  const broker = httpSecretBroker({
    id: "calendar",
    label: "Google Calendar",
    resolve: () => ({
      url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      method: "GET",
      credentials: {
        token: {
          ref: "calendar",
          delivery: { kind: "header", name: "authorization", prefix: "Bearer " },
        },
      },
      operation: "Read planning calendar",
      read: true,
      result: "Calendar events to the integration owner",
    }),
    send: async (_url, init) => {
      sent.push(new Headers(init.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({ items: [{ summary: "Planning" }] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  let protectedOwner: ProtectedSecrets | undefined;
  const open = async (initialize: boolean) => {
    protectedOwner = await ProtectedSecrets.open({
      dir,
      custody,
      initialize,
      environment: () => ({}),
      now: () => now,
      authentication: {
        available: async () => true,
        confirm: async () => {
          confirms += 1;
          return confirmation;
        },
      },
    });
    return protectedOwner;
  };
  const make = (register = true, recovery?: HostSecretsRecovery) => {
    const controller = new SecretsSettings({
      open,
      ...(recovery ? { recovery } : {}),
      raise: (card) => {
        cards.push(card);
      },
      withdraw: (id) => {
        withdrawn.push(id);
      },
      settled: (task, receipt) => {
        ended.push({ task, receipt });
      },
      changed: () => {},
      taskTitle: (task) => TASK_TITLES[task],
      now: () => now,
    });
    if (register) controller.registerBroker(broker);
    return controller;
  };
  const settings = make();
  const request = (id: string, task?: string) =>
    settings.broker(
      {
        id,
        reason: "Read my next planning meeting",
        broker: "calendar",
        input: { calendar: "primary" },
      },
      task,
    );
  const click = async (label: string, card = cards.at(-1), controller = settings) => {
    const effect = card?.actions.find((action) => action.label === label)?.effect;
    if (effect?.kind !== "host" || effect.op !== "secrets-decision" || !effect.arg)
      throw new Error("No trusted action with that label.");
    await controller.decide(effect.arg);
  };
  /**
   * The Settings page answering the question on its row: the pass the view
   * carried, sent through the window's own action, as SecretsTab sends it.
   */
  const answer = async (
    label: string,
    question?: SecretsView["question"],
    controller = settings,
  ): Promise<SecretsView> => {
    const asked = question === undefined ? (await controller.view()).question : question;
    const pass =
      asked?.confirm.label === label
        ? asked.confirm.pass
        : asked?.keep.label === label
          ? asked.keep.pass
          : undefined;
    if (!pass) throw new Error("No question on a Settings row answers with that label.");
    return controller.action({ kind: "answer", pass });
  };
  return {
    settings,
    make,
    broker,
    cards,
    withdrawn,
    ended,
    click,
    answer,
    request,
    sent,
    custody,
    dir,
    owner: async () => {
      await settings.view();
      if (!protectedOwner) throw new Error("No protected owner.");
      return protectedOwner;
    },
    confirms: () => confirms,
    confirmation: (value: boolean) => {
      confirmation = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("trusted Secrets settings", () => {
  it("a delayed refresh cannot bring deleted history back into the current view", async () => {
    // INF-1109: the displayed result of an explicit deletion must stay deleted.
    const f = fixture();
    await f.settings.put(INPUT);
    const receipt = await f.request("before-history-deletion");
    await f.click(SECRETS_WORDS.once);
    await f.settings.takeBrokerResult(receipt.request);
    await f.settings.action({ kind: "delete-history" });
    let release!: () => void;
    let began!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const read = f.custody.read;
    let once = true;
    f.custody.read = async (slot) => {
      const observed = await read(slot);
      if (once && slot === "root") {
        once = false;
        began();
        await held;
      }
      return observed;
    };
    const earlier = f.settings.view();
    await started;
    try {
      await f.answer(SECRET_QUESTION_WORDS.deleteHistory);
      const current = await f.settings.view();
      expect(current.history).toEqual([]);
      release();
      const late = await earlier;
      expect(late.history).toEqual(current.history);
      expect(late.message).toBe(current.message);
    } finally {
      release();
      await earlier;
    }
  });

  it("an earlier metadata refresh cannot replace the restored home's view", async () => {
    // INF-1109 recovery: queued views must not republish the retired owner.
    const f = fixture();
    let backup: RecoveryFiles | undefined;
    const settings = f.make(true, {
      chooseSave: async () => async (files) => {
        backup = { archive: Buffer.from(files.archive), key: Buffer.from(files.key) };
        return "saved";
      },
      chooseRestore: async () => {
        if (!backup) throw new Error("No fixture archive.");
        return { archive: Buffer.from(backup.archive), key: Buffer.from(backup.key) };
      },
    });
    await settings.put(INPUT);
    await settings.action({ kind: "backup-recovery" });
    let release!: () => void;
    let began!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const read = f.custody.read;
    let once = true;
    f.custody.read = async (slot) => {
      const observed = await read(slot);
      if (once && slot === "root") {
        once = false;
        began();
        await held;
      }
      return observed;
    };
    const earlier = settings.view();
    await started;
    const restored = await settings.action({ kind: "restore-recovery" });
    release();
    const latest = await earlier;
    expect(restored.message).toBe(SECRETS_RECOVERY_WORDS.restore.restored);
    expect(latest.home).toBe(restored.home);
    expect(latest.entries).toEqual(restored.entries);
    expect(latest.message).toBe(restored.message);
  });

  it("saves and restores through private file choices, retires earlier offers and clears selected buffers", async () => {
    const f = fixture();
    let backup: RecoveryFiles | undefined;
    let selected: RecoveryFiles | undefined;
    const settings = f.make(true, {
      chooseSave: async () => async (files) => {
        backup = { archive: Buffer.from(files.archive), key: Buffer.from(files.key) };
        return "saved";
      },
      chooseRestore: async () => {
        if (!backup) throw new Error("No fixture backup.");
        selected = { archive: Buffer.from(backup.archive), key: Buffer.from(backup.key) };
        return selected;
      },
    });
    await settings.put(INPUT);
    const original = await settings.view();
    expect(original.recoveryAvailable).toBe(true);
    expect((await settings.action({ kind: "backup-recovery" })).message).toBe(
      SECRETS_RECOVERY_WORDS.save.saved,
    );
    const oldQuestion = (await settings.action({ kind: "forget", ref: INPUT.ref })).question;
    const restored = await settings.action({ kind: "restore-recovery" });
    expect(restored.message).toBe(SECRETS_RECOVERY_WORDS.restore.restored);
    expect(restored.home).not.toBe(original.home);
    expect(restored.entries[0]?.label).toBe(INPUT.label);
    expect(restored.entries[0]?.revision).not.toBe(original.entries[0]?.revision);
    expect(secretsViewSchema.safeParse(restored).success).toBe(true);
    expect(JSON.stringify(restored)).not.toContain(TOKEN);
    expect(selected?.archive.every((byte) => byte === 0)).toBe(true);
    expect(selected?.key.every((byte) => byte === 0)).toBe(true);
    expect(restored.question).toBeNull();
    await f.answer(SECRET_QUESTION_WORDS.forget, oldQuestion, settings);
    expect((await settings.view()).entries).toHaveLength(1);
  });

  it("cancelled file selection changes neither entries nor native authority", async () => {
    const f = fixture();
    const settings = f.make(true, {
      chooseSave: async () => undefined,
      chooseRestore: async () => undefined,
    });
    await settings.put(INPUT);
    const original = await settings.view();
    expect((await settings.action({ kind: "backup-recovery" })).message).toBe(
      SECRETS_RECOVERY_WORDS.cancelled,
    );
    const cancelled = await settings.action({ kind: "restore-recovery" });
    expect(cancelled.message).toBe(SECRETS_RECOVERY_WORDS.cancelled);
    expect(cancelled.entries).toEqual(original.entries);
    expect(cancelled.home).toBe(original.home);
  });

  it("Start over turns a removed data folder's leftover custody into an empty list the captain can add to", async () => {
    // INF-3865: a data folder removed while custody kept its items opened as
    // tampered, with only a restore from recovery files. Starting over asks the
    // system once, says what happened and reopens; a usable store asks nothing.
    const f = fixture();
    await f.settings.put(INPUT);
    await rm(f.dir, { recursive: true });
    const settings = f.make();
    expect((await settings.view()).availability).toBe("tampered");
    const asked = f.confirms();

    f.confirmation(false);
    const refused = await settings.action({ kind: "start-over" });
    expect(refused.message).toBe(SECRETS_RECOVERY_WORDS.startOver.refused);
    expect(refused.availability).toBe("tampered");
    f.confirmation(true);
    const started = await settings.action({ kind: "start-over" });
    expect(started.message).toBe(SECRETS_RECOVERY_WORDS.startOver.started);
    expect(started.availability).toBe("available");
    expect(started.entries).toEqual([]);
    expect(started.rules).toEqual([]);
    expect(secretsViewSchema.safeParse(started).success).toBe(true);
    expect(f.confirms()).toBe(asked + 2);

    expect((await settings.action({ kind: "start-over" })).message).toBe(
      SECRETS_RECOVERY_WORDS.startOver.unneeded,
    );
    expect(f.confirms()).toBe(asked + 2);
    expect((await settings.put(INPUT)).entries.map((entry) => entry.label)).toEqual([INPUT.label]);
  });

  it("a data folder that comes back while Settings is open is used, never started over", async () => {
    // INF-3865's careful review: the controller kept the owner that opened
    // without its records, so Start over acted on that old tampered reading and
    // replaced custody the returned folder could still read.
    const f = fixture();
    await f.settings.put(INPUT);
    const kept = join(scratchDir("secrets-kept-folder-"), "secrets");
    await cp(f.dir, kept, { recursive: true });
    await rm(f.dir, { recursive: true });
    const settings = f.make();
    expect((await settings.view()).availability).toBe("tampered");
    await rm(f.dir, { recursive: true, force: true });
    await cp(kept, f.dir, { recursive: true });
    const asked = f.confirms();

    const answer = await settings.action({ kind: "start-over" });
    expect(answer.message).toBe(SECRETS_RECOVERY_WORDS.startOver.unneeded);
    expect(answer.availability).toBe("available");
    expect(answer.entries.map((entry) => entry.label)).toEqual([INPUT.label]);
    expect(f.confirms()).toBe(asked);
  });

  it("a core consumer can register after storage opens, but cannot replace a registered adapter", async () => {
    // INF-1109 supplies INF-785's consumer seam without moving its protocol or renewer.
    const f = fixture();
    const controller = f.make(false);
    await controller.put(INPUT);
    controller.registerBroker(f.broker);
    expect(() => controller.registerBroker(f.broker)).toThrow("Duplicate secret broker.");
    const requested = await controller.broker({
      id: "registered-read",
      reason: "Read my next meeting",
      broker: "calendar",
      input: { calendar: "primary" },
    });
    expect(requested.state).toBe("waiting");
    expect((await controller.view()).uses[0]?.shortReadEligible).toBe(true);
    expect(f.sent).toEqual([]);
  });

  it("production without a protected owner stays off and accepts no value or approval", async () => {
    const cards: Raised[] = [];
    const settings = new SecretsSettings({
      raise: (card) => {
        cards.push(card);
      },
      withdraw: () => {},
      changed: () => {},
    });
    // INF-1690's accepted answer: such a build offers no Secrets tab at all.
    expect(settings.shown()).toBe(false);
    expect(await settings.view()).toMatchObject({
      availability: "not-enabled",
      entries: [],
      uses: [],
    });
    expect(await settings.put(INPUT)).toMatchObject({
      availability: "not-enabled",
      message: SECRETS_WORDS.disabled,
    });
    await settings.decide("invented-offer");
    expect(cards).toEqual([]);
  });

  it("secure entry seals the value and returns versioned metadata without disclosing it", async () => {
    const f = fixture();
    expect(f.settings.shown()).toBe(true);
    expect((await f.settings.view()).availability).toBe("uninitialized");
    const view = await f.settings.put(INPUT);
    expect(secretsViewSchema.safeParse(view).success).toBe(true);
    expect(view.entries).toEqual([
      {
        ref: INPUT.ref,
        label: INPUT.label,
        version: 1,
        revision: expect.any(String),
        updatedAt: 1000,
        environment: INPUT.environment,
        lastRequest: null,
      },
    ]);
    expect(view.saved).toEqual({ ref: INPUT.ref, version: 1 });
    expect((await f.make().view()).entries).toEqual(view.entries);
    expect((await f.make().view()).saved).toBeUndefined();
    const records = await readdir(join(f.dir, "values"));
    const sealed = await readFile(join(f.dir, "values", records[0] as string), "utf8");
    expect(JSON.stringify(view) + sealed + JSON.stringify(f.cards)).not.toContain(TOKEN);
    expect(sealed).not.toContain(Buffer.from(TOKEN).toString("base64"));
    expect(f.confirms()).toBe(0);
    expect(f.custody.writes).toContain("root");
  });

  it("every crewmate's command lists the same catalog, which names no value and grants no use", async () => {
    // The captain on INF-1109: "it should just be global discovery". Listing is
    // metadata only; each use still needs this computer's exact approval.
    const f = fixture();
    await f.settings.put(INPUT);
    await f.settings.put({
      ...INPUT,
      ref: "staging-deploy",
      label: "Staging deploy token",
      environment: "Staging",
    });
    await f.settings.put({ ...INPUT, ref: "notes", label: "Notes key", environment: "" });
    // A record sealed without the agent-facing mark stays out of the catalog and cannot be used.
    await (await f.owner()).putSecret("internal-root", "Internal", Buffer.from("not-for-crew"));
    // The environment label is context beside a name, never a filter.
    const catalog = [
      { ref: INPUT.ref, label: INPUT.label, version: "1", environment: "Personal" },
      { ref: "notes", label: "Notes key", version: "1" },
      {
        ref: "staging-deploy",
        label: "Staging deploy token",
        version: "1",
        environment: "Staging",
      },
    ];
    const local = f.settings.commandFor({ task: "task-a" });
    const otherProject = f.settings.commandFor({ task: "task-b" });
    const repoless = f.settings.commandFor({ task: "" });
    expect(await local.list()).toEqual(catalog);
    expect(await otherProject.list()).toEqual(catalog);
    expect(await repoless.list()).toEqual(catalog);
    expect(JSON.stringify(await local.list())).not.toContain(TOKEN);

    const cwd = await realpath(f.dir);
    const script = join(cwd, "check-planning.sh");
    await writeFile(script, 'test -n "$SERVICE_TOKEN"\n');
    const use = (ref: string) => ({
      id: `use-${ref}`,
      reason: "Check the listed key",
      cwd,
      argv: ["/bin/sh", script],
      env: { SERVICE_TOKEN: ref },
    });
    const listed = await otherProject.inject(use(INPUT.ref));
    expect(listed.state).toBe("waiting");
    expect(f.cards.at(-1)?.title).toBe(
      SECRET_APPROVAL_CARD_WORDS.title(CALENDAR, TASK_TITLES["task-b"] ?? null),
    );
    expect(f.confirms()).toBe(0);
    expect((await otherProject.inject(use("internal-root"))).state).toBe("unavailable");
    await otherProject.cancel(listed.request);
  });

  it("names each requested secret as its use prepared it, so two of one name stay apart", async () => {
    // The captain on INF-1109: "right now it's not even clear what secrets are
    // being requested". Each one carries the name, environment, reference and
    // version of the record the use prepared, never a later replacement's.
    const f = fixture();
    await f.settings.put({
      ...INPUT,
      ref: "github-token",
      label: "GitHub token",
      environment: "Staging",
    });
    await f.settings.put({
      ...INPUT,
      ref: "github-token-2",
      label: "GitHub token",
      environment: "Production",
    });
    const cwd = await realpath(f.dir);
    const script = join(cwd, "publish.sh");
    await writeFile(script, 'test -n "$STAGING_TOKEN" && test -n "$PRODUCTION_TOKEN"\n');
    const receipt = await f.settings.commandFor({ task: "release-task" }).inject({
      id: "publish",
      reason: "Publish the release to both environments",
      cwd,
      argv: ["/bin/sh", script],
      env: { STAGING_TOKEN: "github-token", PRODUCTION_TOKEN: "github-token-2" },
    });
    expect(receipt.state).toBe("waiting");
    const requested = [
      { ref: "github-token", label: "GitHub token", version: 1, environment: "Staging" },
      { ref: "github-token-2", label: "GitHub token", version: 1, environment: "Production" },
    ];
    const use = (await f.settings.view()).uses.find((one) => one.request === receipt.request);
    expect(use?.secrets).toEqual(requested);
    const approvals = secretApprovalsSchema.parse(await f.settings.approvals("a-phone"));
    // The phone also reads the name the card gives each, so both name them alike.
    expect(approvals.waiting.find((one) => one.request === receipt.request)?.secrets).toEqual(
      requested.map((one) => ({ ...one, name: secretName(requested, one.ref) })),
    );
    expect(JSON.stringify([use, approvals])).not.toContain(TOKEN);

    // A replacement under a new environment label does not rename the prepared use.
    const production = (await f.settings.view()).entries.find(
      (one) => one.ref === "github-token-2",
    );
    await f.settings.put({
      ...INPUT,
      ref: "github-token-2",
      label: "GitHub token",
      value: `${TOKEN}-replaced`,
      expectedVersion: 1,
      expectedRevision: production?.revision ?? null,
      environment: "Retired",
    });
    const after = await f.settings.view();
    expect(after.entries.find((one) => one.ref === "github-token-2")?.environment).toBe("Retired");
    expect(after.uses.find((one) => one.request === receipt.request)?.secrets).toEqual(requested);
    expect(
      (await f.settings.approvals("a-phone")).waiting.find((one) => one.request === receipt.request)
        ?.secrets,
    ).toEqual(requested.map((one) => ({ ...one, name: secretName(requested, one.ref) })));
  });

  it("adds a secret with no reference under a stable one made from its name", async () => {
    // INF-1109's revision: adding a value never asks the captain to invent a reference.
    const f = fixture();
    const { ref: _ref, ...unnamed } = INPUT;
    const first = await f.settings.put({ ...unnamed, label: "GitHub token (work)" });
    expect(first.message).toBe(SECRETS_WORDS.saved);
    expect(first.saved).toEqual({ ref: "github-token-work", version: 1 });
    const second = await f.settings.put({ ...unnamed, label: "GitHub token (work)" });
    expect(second.saved).toEqual({ ref: "github-token-work-2", version: 1 });
    expect(second.entries.map((entry) => [entry.ref, entry.label])).toEqual([
      ["github-token-work", "GitHub token (work)"],
      ["github-token-work-2", "GitHub token (work)"],
    ]);
    expect((await f.settings.put({ ...unnamed, label: "密钥" })).saved?.ref).toBe("secret");
    const long = await f.settings.put({ ...unnamed, label: `Ünïcode ${"x".repeat(90)}` });
    expect(long.saved?.ref).toMatch(/^unicode-x+$/);
    expect(long.saved?.ref.length).toBeLessThanOrEqual(64);

    // A rule kept for a forgotten secret never comes to name a new one.
    const owner = await f.owner();
    const proposal = owner.proposeAuthority({
      rules: [
        { id: "kept", effect: "allow", secret: "planning-calendar", operation: "a".repeat(64) },
      ],
      devices: [],
    });
    if (!proposal) throw new Error("No rule proposal.");
    const proof = await owner.confirmAuthority(proposal.digest, 1_000_000, "Save the kept rule.");
    expect(await owner.saveAuthority(proposal.authority, proof)).toBe("stored");
    const after = await f.settings.put({ ...unnamed, label: "Planning calendar" });
    expect(after.saved?.ref).toBe("planning-calendar-2");

    // A replacement names its own entry; without one nothing is written.
    const entry = after.entries.find((one) => one.ref === "planning-calendar-2");
    if (!entry) throw new Error("No entry to replace.");
    const refused = await f.settings.put({
      ...unnamed,
      value: "replacement",
      expectedVersion: entry.version,
      expectedRevision: entry.revision,
    });
    expect(refused.message).toBe(SECRETS_WORDS.unavailable);
    expect(refused.saved).toBeUndefined();
    expect(refused.entries).toEqual(after.entries);
    expect(JSON.stringify([first, second, after, refused])).not.toContain(TOKEN);
  });

  it("two replacements of one displayed version cannot silently overwrite each other", async () => {
    const f = fixture();
    const original = (await f.settings.put(INPUT)).entries[0];
    if (!original) throw new Error("No entry to replace.");
    const edit = {
      ...INPUT,
      expectedVersion: original.version,
      expectedRevision: original.revision,
    };
    const versions = await Promise.all([
      f.settings.put({ ...edit, value: "replacement-one" }),
      f.settings.put({ ...edit, value: "replacement-two" }),
    ]);
    expect(versions.every((view) => view.entries[0]?.version === 2)).toBe(true);
    expect((await f.settings.view()).entries[0]?.version).toBe(2);
    expect((await f.settings.put(INPUT)).message).toBe(SECRETS_WORDS.stale);
  });

  it("a replacement form cannot overwrite a removed and re-added entry with the same version", async () => {
    // INF-1109 recovery/secure entry: a displayed version is not an entry's identity.
    const f = fixture();
    const original = (await f.settings.put(INPUT)).entries[0];
    if (!original) throw new Error("No entry to replace.");
    const staleForm = {
      ...INPUT,
      expectedVersion: original.version,
      expectedRevision: original.revision,
      value: "stale replacement",
    };
    await f.settings.action({ kind: "forget", ref: INPUT.ref });
    await f.answer(SECRET_QUESTION_WORDS.forget);
    const recreated = await f.settings.put({ ...INPUT, label: "New planning credential" });
    expect(recreated.entries[0]?.version).toBe(original.version);
    const refused = await f.settings.put(staleForm);
    expect(refused.message).toBe(SECRETS_WORDS.stale);
    expect(refused.entries).toEqual(recreated.entries);
    await f.request("after-stale-replacement");
    await f.click(SECRETS_WORDS.once);
    expect(f.sent).toEqual([`Bearer ${TOKEN}`]);
  });

  // Intent: the captain's ask (INF-4090, direction A): "let's plan for the
  // confirmation flow to happen in the settings page right where the forget
  // flow already is". Forget asks on its row with no card, and only the
  // one-time pass the host made for that question, spent once from the
  // Settings page, forgets.
  it("Forget asks on its Settings row, never a card, and only that question's pass forgets, once", async () => {
    const f = fixture();
    const saved = (await f.settings.put(INPUT)).entries[0];
    if (!saved) throw new Error("No entry to forget.");
    const asked = (await f.settings.action({ kind: "forget", ref: INPUT.ref })).question;
    expect(f.cards).toEqual([]);
    expect(asked).toMatchObject({
      about: { kind: "forget", ref: INPUT.ref },
      title: SECRET_QUESTION_WORDS.forgetTitle(INPUT.label),
      lines: [...SECRET_QUESTION_WORDS.forgetLines],
      confirm: { label: SECRET_QUESTION_WORDS.forget },
      keep: { label: SECRET_QUESTION_WORDS.keepSecret },
    });
    if (!asked) throw new Error("Forget asked nothing.");
    expect((await f.settings.view()).offeredCard).toBeNull();

    // A made-up pass, and the question's own pass sent as card chrome, do nothing.
    await f.settings.action({ kind: "answer", pass: "made-up" });
    await f.settings.decide(asked.confirm.pass);
    expect((await f.settings.view()).entries).toHaveLength(1);
    expect((await f.settings.view()).question).toEqual(asked);

    // Keep secret changes nothing and closes the question; its passes stop working.
    const kept = await f.answer(SECRET_QUESTION_WORDS.keepSecret);
    expect(kept.question).toBeNull();
    expect(kept.entries).toEqual([saved]);
    await f.settings.action({ kind: "answer", pass: asked.confirm.pass });
    expect((await f.settings.view()).entries).toEqual([saved]);

    // Another Secrets action drops an open question, and its pass with it.
    const dropped = (await f.settings.action({ kind: "forget", ref: INPUT.ref })).question;
    await f.settings.action({ kind: "delete-history" });
    expect((await f.settings.view()).question?.about).toEqual({ kind: "history" });
    await f.answer(SECRET_QUESTION_WORDS.forget, dropped);
    expect((await f.settings.view()).entries).toEqual([saved]);

    // Forget secret forgets it, says so, and a second answer does nothing more.
    const again = (await f.settings.action({ kind: "forget", ref: INPUT.ref })).question;
    const forgotten = await f.answer(SECRET_QUESTION_WORDS.forget, again);
    expect(forgotten.entries).toEqual([]);
    expect(forgotten.question).toBeNull();
    expect(forgotten.message).toBe(SECRET_QUESTION_WORDS.forgotten);
    const replaced = await f.settings.put(INPUT);
    await f.answer(SECRET_QUESTION_WORDS.forget, again);
    expect((await f.settings.view()).entries).toEqual(replaced.entries);
    expect(f.cards).toEqual([]);
    expect(f.confirms()).toBe(0);

    // The window carries card offers too: an approval card's offer sent as a Settings answer
    // spends nothing, asks nothing and leaves the card and its use waiting.
    const receipt = await f.request("card-offer-as-answer");
    const card = f.cards.at(-1);
    const offer = card?.actions.find((action) => action.label === SECRETS_WORDS.once)?.effect;
    if (offer?.kind !== "host" || !offer.arg) throw new Error("No approval card offer.");
    f.confirmation(true);
    await f.settings.action({ kind: "answer", pass: offer.arg });
    expect(f.confirms()).toBe(0);
    expect(f.sent).toEqual([]);
    expect(f.cards).toEqual([card]);
    expect(f.ended).toEqual([]);
    expect(
      (await f.settings.view()).uses.find((use) => use.request === receipt.request)?.state,
    ).toBe("waiting");
  });

  it("a Forget offer cannot delete a different entry that reused its displayed version", async () => {
    // INF-1109's trusted deletion must keep the exact entry the person reviewed.
    const f = fixture();
    await f.settings.put(INPUT);
    const asked = (await f.settings.action({ kind: "forget", ref: INPUT.ref })).question;
    await (await f.owner()).forgetSecret(INPUT.ref);
    const recreated = await f.settings.put({ ...INPUT, label: "New planning credential" });
    await f.answer(SECRET_QUESTION_WORDS.forget, asked);
    expect((await f.settings.view()).entries).toEqual(recreated.entries);
  });

  // INF-4096's accepted plan: an app sign-in stays listed, kept for its service, with no
  // Replace, Forget or saved decision; a decision naming it stops applying and showing,
  // and the next decision the captain confirms leaves it out of the record.
  it("keeps an app sign-in out of Replace, Forget and saved decisions, and drops its decision at the next confirmed save", async () => {
    const f = fixture();
    const kept = await f.settings.keepHidden({
      label: "Google sign-in",
      value: Buffer.from("1//invented-google-refresh"),
    });
    if (!kept) throw new Error("No kept sign-in.");
    await f.settings.put(INPUT);
    const owner = await f.owner();
    const earlier = [
      { id: "renewals", effect: "allow" as const, secret: kept, operation: "a".repeat(64) },
      { id: "calendar", effect: "never" as const, secret: INPUT.ref },
    ];
    const proposal = owner.proposeAuthority({ rules: earlier, devices: [] });
    if (!proposal) throw new Error("No rule proposal.");
    const proof = await owner.confirmAuthority(proposal.digest, 1_000_000, "Save earlier rules.");
    expect(await owner.saveAuthority(proposal.authority, proof)).toBe("stored");

    const view = await f.settings.view();
    expect(view.entries.map((entry) => [entry.ref, entry.kept])).toEqual([
      [INPUT.ref, undefined],
      [kept, true],
    ]);
    expect(view.rules.map((rule) => rule.id)).toEqual(["calendar"]);

    const sign = view.entries.find((entry) => entry.ref === kept);
    if (!sign) throw new Error("No kept row.");
    const replaced = await f.settings.put({
      ...INPUT,
      ref: kept,
      expectedVersion: sign.version,
      expectedRevision: sign.revision,
    });
    expect(replaced.saved).toBeUndefined();
    expect(replaced.entries.find((entry) => entry.ref === kept)?.version).toBe(sign.version);
    const cards = f.cards.length;
    await f.settings.action({ kind: "forget", ref: kept });
    expect(f.cards).toHaveLength(cards);
    const after = await f.settings.view();
    expect(after.question).toBeNull();
    expect(after.entries.map((entry) => entry.ref)).toContain(kept);

    await f.settings.action({ kind: "save-rules", rules: [] });
    await f.answer(SAVED_DECISION_WORDS.removeConfirm);
    expect(owner.authority()?.rules).toEqual([]);
  });

  it("only the exact host offer plus fresh confirmation sends a brokered request, with no raw result in views", async () => {
    const f = fixture();
    await f.settings.put(INPUT);
    const receipt = await f.request("planning-read");
    expect(receipt.state).toBe("waiting");
    expect(f.sent).toEqual([]);
    expect(f.cards.at(-1)?.body).toContain("www.googleapis.com");
    expect(f.cards.at(-1)?.body).not.toContain(TOKEN);
    await f.settings.decide("forged-allow");
    expect(f.confirms()).toBe(0);
    f.confirmation(false);
    await f.click(SECRETS_WORDS.once);
    expect(f.sent).toEqual([]);
    expect((await f.settings.view()).uses[0]?.state).toBe("waiting");
    await f.settings.action({ kind: "review-use", request: receipt.request });
    f.confirmation(true);
    const offer = f.cards.at(-1);
    await Promise.all([f.click(SECRETS_WORDS.once, offer), f.click(SECRETS_WORDS.once, offer)]);
    expect(f.sent).toEqual([`Bearer ${TOKEN}`]);
    expect((await f.settings.view()).uses[0]?.state).toBe("completed");
    const response = await f.settings.takeBrokerResult(receipt.request);
    expect(await (response as Response).json()).toEqual({ items: [{ summary: "Planning" }] });
    expect(await f.settings.takeBrokerResult(receipt.request)).toBeUndefined();
    const exposed = JSON.stringify(await f.settings.view()) + (await f.settings.exportHistory());
    expect(exposed).not.toContain(TOKEN);
    expect(exposed).not.toContain('"summary":"Planning"');
  });

  it("keeps bounded access visible and ends it without a new confirmation", async () => {
    const f = fixture();
    await f.settings.put(INPUT);
    await f.request("bounded-read");
    await f.click(SECRETS_WORDS.short);
    const permission = (await f.settings.view()).reads[0];
    expect(permission?.remaining).toBe(SHORT_READ_USES - 1);
    if (!permission) throw new Error("No bounded read permission.");
    await f.settings.action({ kind: "end-read", id: permission.id });
    expect((await f.settings.view()).reads).toEqual([]);
    expect((await f.request("after-end")).state).toBe("waiting");
    expect(f.confirms()).toBe(1);
  });

  it("namespaces command intent IDs by task without making the task a grant", async () => {
    // INF-30 retains task-scoped idempotency; INF-1093 gives task labels no secret authority.
    const f = fixture();
    await f.settings.put(INPUT);
    const cwd = await realpath(f.dir);
    const script = join(cwd, "check-planning.sh");
    await writeFile(script, 'test -n "$SERVICE_TOKEN"\n');
    const input = {
      id: "planning-check",
      reason: "Check the approved planning key",
      cwd,
      argv: ["/bin/sh", script],
      env: { SERVICE_TOKEN: "calendar" },
    };
    const a = f.settings.commandFor({ task: "task-a" });
    const b = f.settings.commandFor({ task: "task-b" });
    const first = await a.inject(input);
    const second = await b.inject({ ...input, reason: "Check for another planning task" });
    expect(first.state).toBe("waiting");
    expect(second.state).toBe("waiting");
    expect(second.request).not.toBe(first.request);
    expect(await a.inject(input)).toEqual(first);
    await expect(a.inject({ ...input, reason: "A different request" })).rejects.toThrow(
      "different operation",
    );
    await expect(a.inject({ ...input, id: "" })).rejects.toThrow("Invalid injection request");
    expect(f.confirms()).toBe(0);
    expect(f.ended).toEqual([]);
    await a.cancel(first.request);
    await b.cancel(second.request);
  });

  it("names the task that last asked for each secret, across a restart", async () => {
    // INF-1690 piece 1 (the captain's direction B): each row on the Secrets
    // page says which task used the secret and when.
    const f = fixture();
    await f.settings.put(INPUT);
    expect((await f.settings.view()).entries[0]).toMatchObject({ lastRequest: null });
    expect((await f.settings.view()).entries[0]).not.toHaveProperty("lastTask");
    const cwd = await realpath(f.dir);
    const asked = await f.settings.commandFor({ task: "task-a" }).inject({
      id: "planning-check",
      reason: "Check the approved planning key",
      cwd,
      argv: ["/bin/sh", "-c", "exit 0"],
      env: { SERVICE_TOKEN: "calendar" },
    });
    expect((await f.settings.view()).entries[0]).toMatchObject({
      lastRequest: 1000,
      lastTask: TASK_TITLES["task-a"],
    });
    // The history keeps the asking task, so a reopened home still names it.
    expect((await f.make().view()).entries[0]?.lastTask).toBe(TASK_TITLES["task-a"]);
    await f.settings.commandFor({ task: "task-a" }).cancel(asked.request);
    f.advance(1000);
    await f.request("brokered-for-b", "task-b");
    expect((await f.settings.view()).entries[0]).toMatchObject({
      lastRequest: 2000,
      lastTask: TASK_TITLES["task-b"],
    });
    // A request no task made, or one by a task the home no longer knows, names only when.
    f.advance(1000);
    await f.request("brokered-without-task");
    expect((await f.settings.view()).entries[0]).toMatchObject({ lastRequest: 3000 });
    expect((await f.settings.view()).entries[0]).not.toHaveProperty("lastTask");
    f.advance(1000);
    await f.settings.commandFor({ task: "task-gone" }).inject({
      id: "planning-check",
      reason: "Check the approved planning key",
      cwd,
      argv: ["/bin/sh", "-c", "exit 0"],
      env: { SERVICE_TOKEN: "calendar" },
    });
    expect((await f.settings.view()).entries[0]).toMatchObject({ lastRequest: 4000 });
    expect((await f.settings.view()).entries[0]).not.toHaveProperty("lastTask");
  });

  it("delivers one terminal receipt to each waiting requester, never the broker's value or result", async () => {
    // INF-30: an Ask releases the command channel and the outcome resumes its task through the inbox.
    const f = fixture();
    await f.settings.put(INPUT);
    const receipt = await f.request("shared-planning-read", "task-a");
    await f.request("shared-planning-read", "task-b");
    expect(f.ended).toEqual([]);
    f.confirmation(false);
    await f.click(SECRETS_WORDS.once);
    expect(f.ended).toEqual([]);
    f.confirmation(true);
    await f.click(SECRETS_WORDS.once);
    expect(f.ended).toEqual([
      { task: "task-a", receipt: { request: receipt.request, state: "completed" } },
      { task: "task-b", receipt: { request: receipt.request, state: "completed" } },
    ]);
    expect(f.withdrawn).toContain(`card-secrets-use-${receipt.request}`);
    expect(f.settings.commandFor({ task: "task-a" }).receipts()).toHaveLength(1);
    await f.request("shared-planning-read", "task-a");
    expect(f.ended).toHaveLength(2);
    expect(f.sent).toHaveLength(1);
  });

  it("withdraws a cancelled use and refuses its old offer without waking the cancelling caller", async () => {
    const f = fixture();
    await f.settings.put(INPUT);
    const receipt = await f.request("cancel-planning-read", "task-a");
    const offer = f.cards.at(-1);
    const command = f.settings.commandFor({ task: "task-a" });
    expect((await command.cancel(receipt.request))?.state).toBe("cancelled");
    expect(f.ended).toEqual([]);
    expect(f.withdrawn).toContain(`card-secrets-use-${receipt.request}`);
    await f.click(SECRETS_WORDS.once, offer);
    expect(f.confirms()).toBe(0);
    expect(f.sent).toEqual([]);
  });

  it("clears a refused confirmation notice when the reoffered card completes the use", async () => {
    // INF-1109 app capture: the request completed but Settings still said it was waiting.
    const f = fixture();
    await f.settings.put(INPUT);
    await f.request("reoffered-use");
    f.confirmation(false);
    await f.click(SECRETS_WORDS.once);
    expect((await f.settings.view()).message).not.toBeNull();
    f.confirmation(true);
    await f.click(SECRETS_WORDS.once);
    const view = await f.settings.view();
    expect(view.uses[0]?.state).toBe("completed");
    expect(view.message).toBeNull();
    expect(view.offeredCard).toBeNull();
  });

  // Intent: INF-1690's accepted plan, "Only from the approval card": Settings
  // can remove a saved decision but never add or change one, whatever it sends.
  it("adds no decision from Settings: only a removal is offered, and nothing else is saved", async () => {
    const f = fixture();
    await f.settings.put(INPUT);
    const rules = [
      {
        id: "no-calendar",
        effect: "never" as const,
        secret: "calendar",
        note: "Keep this account private",
      },
    ];
    const cards = f.cards.length;
    const view = await f.settings.action({ kind: "save-rules", rules });
    expect(view.message).toBe(SAVED_DECISION_WORDS.onlyRemove);
    expect(f.cards).toHaveLength(cards);
    expect(view.rules).toEqual([]);
    expect(f.confirms()).toBe(0);
    expect((await f.request("forbidden-read")).state).toBe("waiting");
    expect(f.sent).toEqual([]);
  });

  // Intent: INF-1690's accepted plan, the captain's answer on how a saved
  // decision is made: "Only from the approval card: Always allow this run [...].
  // The page lists saved decisions with Remove and has no editor." INF-4088
  // removed the other half, Don't allow and stop asking.
  async function deployRun(f: ReturnType<typeof fixture>) {
    await f.settings.put({
      ...INPUT,
      ref: "website-staging",
      label: "Website deployment",
      environment: "Staging",
    });
    const cwd = await realpath(f.dir);
    const script = join(cwd, "deploy.sh");
    await writeFile(script, 'test -n "$DEPLOY_TOKEN"\n');
    const command = f.settings.commandFor({ task: "deploy-task" });
    const run = (id: string, args: string[] = []) =>
      command.inject({
        id,
        reason: "Deploy the website to staging and check it",
        cwd,
        argv: ["/bin/sh", script, ...args],
        env: { DEPLOY_TOKEN: "website-staging" },
      });
    return { run, cwd };
  }
  const STAGING = secretsNamed(["Website deployment"]);

  it("Always allow this runs the shown use now and saves it, under one confirmation", async () => {
    const f = fixture();
    const { run, cwd } = await deployRun(f);
    const first = await run("deploy-1", ["--staging"]);
    expect(first.state).toBe("waiting");
    const card = f.cards.at(-1);
    expect(card?.title).toBe(SECRET_APPROVAL_CARD_WORDS.title(STAGING, "Deploy the site"));
    // INF-4087's answer 5: refusal first. The default comes first here and the
    // footer draws it last, so the card reads Don't allow, Always allow this, Allow once.
    expect(card?.actions.map((action) => action.label)).toEqual([
      SECRETS_WORDS.once,
      SECRETS_WORDS.deny,
      SECRETS_WORDS.always,
    ]);
    expect(card?.actions.map((action) => action.variant)).toEqual(["primary", "ghost", "ghost"]);
    expect(card?.body).toContain(SECRET_APPROVAL_CARD_WORDS.asked("Deploy the site"));
    // The checked program's own path (the captain's review answer), not the request's word.
    const run1 = `${await realpath("/bin/sh")} deploy.sh --staging`;
    expect(card?.body).toContain(run1);
    expect(card?.body).toContain(cwd);

    const before = f.confirms();
    await f.click(SECRETS_WORDS.always);
    expect(f.confirms()).toBe(before + 1);
    await vi.waitFor(async () =>
      expect(
        (await f.settings.view()).uses.find((one) => one.request === first.request)?.state,
      ).toBe("completed"),
    );
    const view = await f.settings.view();
    expect(view.message).toBe(SECRET_APPROVAL_CARD_WORDS.allowed);
    expect(view.rules).toMatchObject([{ effect: "allow", secret: "website-staging", note: run1 }]);

    // The same run never asks again; a different one still does.
    const cards = f.cards.length;
    const again = await run("deploy-2", ["--staging"]);
    await vi.waitFor(async () =>
      expect(
        (await f.settings.view()).uses.find((one) => one.request === again.request)?.state,
      ).toBe("completed"),
    );
    expect(f.cards).toHaveLength(cards);
    expect(f.confirms()).toBe(before + 1);
    expect((await run("deploy-3", ["--production"])).state).toBe("waiting");

    // The page removes it with Remove; its question says what it removes, in the page's sentence,
    // naming the run the approval card showed.
    const shown = await f.settings.view();
    const saved = shown.rules[0];
    if (!saved) throw new Error("Always allow this saved no decision");
    const removing = (await f.settings.action({ kind: "save-rules", rules: [] })).question;
    expect(removing?.about).toEqual({ kind: "rule", rule: saved.id });
    expect(removing?.title).toBe(SAVED_DECISION_WORDS.removeTitle);
    expect(removing?.lines).toContain(
      decisionWords(saved, secretName(shown.entries, saved.secret)),
    );
    expect(removing?.lines[0]).toContain(`to ${run1}.`);
    await f.answer(SAVED_DECISION_WORDS.removeConfirm);
    expect((await f.settings.view()).rules).toEqual([]);
    expect((await run("deploy-4", ["--staging"])).state).toBe("waiting");
  });

  // Review of INF-1690 piece 2: the decision was saved only after the run ended,
  // by when its confirmation could have expired. A run that outlasts it keeps the decision.
  it("Always allow this saves the decision once the run starts, however long the run takes", async () => {
    const f = fixture();
    const { cwd } = await deployRun(f);
    const release = join(cwd, "release");
    const script = join(cwd, "long.sh");
    await writeFile(script, `while [ ! -e "${release}" ]; do sleep 0.05; done\n`);
    // The script loops until the release exists, so write it whatever happened.
    try {
      const long = await f.settings.commandFor({ task: "deploy-task" }).inject({
        id: "deploy-long",
        reason: "Deploy the website to staging and wait for it",
        cwd,
        argv: ["/bin/sh", script],
        env: { DEPLOY_TOKEN: "website-staging" },
      });
      await f.click(SECRETS_WORDS.always);
      const running = await f.settings.view();
      expect(running.uses.find((one) => one.request === long.request)?.state).toBe("executing");
      expect(running.message).toBe(SECRET_APPROVAL_CARD_WORDS.allowed);
      expect(running.rules).toMatchObject([
        {
          effect: "allow",
          secret: "website-staging",
          note: `${await realpath("/bin/sh")} long.sh`,
        },
      ]);
      f.advance(SECRET_REQUEST_LIFETIME_MS * 2);
      await writeFile(release, "");
      await vi.waitFor(async () =>
        expect(
          (await f.settings.view()).uses.find((one) => one.request === long.request)?.state,
        ).toBe("completed"),
      );
      expect((await f.settings.view()).rules).toHaveLength(1);
    } finally {
      await writeFile(release, "");
    }
  });

  it("Always allow this saves nothing and runs nothing when confirmation fails", async () => {
    const f = fixture();
    const { run } = await deployRun(f);
    const first = await run("deploy-1", ["--staging"]);
    f.confirmation(false);
    await f.click(SECRETS_WORDS.always);
    const view = await f.settings.view();
    expect(view.uses.find((one) => one.request === first.request)?.state).toBe("waiting");
    expect(view.rules).toEqual([]);
    // The same card comes back, saying nothing was accepted.
    expect(f.cards.at(-1)?.title).toBe(
      SECRET_APPROVAL_CARD_WORDS.title(STAGING, "Deploy the site"),
    );
  });

  // Intent: INF-4088's accepted plan, the captain: the "Stop asking" card after
  // Don't allow "is totally unnecessary". Don't allow only refuses this use.
  it("Don't allow ends the use, raises no other card and saves nothing, so the next run asks again", async () => {
    const f = fixture();
    const { run } = await deployRun(f);
    const first = await run("deploy-1", ["--staging"]);
    const before = f.confirms();
    await f.click(SECRETS_WORDS.deny);
    expect(f.confirms()).toBe(before);
    const view = await f.settings.view();
    expect(view.uses.find((one) => one.request === first.request)?.state).toBe("denied");
    expect(view.rules).toEqual([]);
    const cards = f.cards.length;
    expect(f.cards.at(-1)?.title).toBe(
      SECRET_APPROVAL_CARD_WORDS.title(STAGING, "Deploy the site"),
    );
    expect((await run("deploy-2", ["--staging"])).state).toBe("waiting");
    expect(f.cards).toHaveLength(cards + 1);
    expect(f.cards.at(-1)?.title).toBe(
      SECRET_APPROVAL_CARD_WORDS.title(STAGING, "Deploy the site"),
    );
  });

  // Intent: INF-4088's accepted plan, the captain's answer on Never decisions a
  // computer already saved: "Keep them. Each keeps refusing its secret, and
  // Settings → Secrets lists it with Remove."
  it("a Never decision saved earlier still refuses its secret, and Settings removes it with Remove", async () => {
    const f = fixture();
    const { run } = await deployRun(f);
    const owner = await f.owner();
    const proposal = owner.proposeAuthority({
      rules: [{ id: "never-staging", effect: "never", secret: "website-staging" }],
      devices: owner.authority()?.devices ?? [],
    });
    if (!proposal) throw new Error("no authority");
    const proof = await owner.confirmAuthority(proposal.digest, 1000 + 300_000, "Save rule");
    expect(await owner.saveAuthority(proposal.authority, proof)).toBe("stored");

    const shown = await f.settings.view();
    expect(shown.rules).toMatchObject([{ effect: "never", secret: "website-staging" }]);
    const cards = f.cards.length;
    expect((await run("deploy-1", ["--production"])).state).toBe("denied");
    expect(f.cards).toHaveLength(cards);

    const saved = shown.rules[0];
    if (!saved) throw new Error("no saved decision");
    const removing = (await f.settings.action({ kind: "save-rules", rules: [] })).question;
    expect(f.cards).toHaveLength(cards);
    expect(removing?.title).toBe(SAVED_DECISION_WORDS.removeTitle);
    expect(removing?.lines).toContain(
      decisionWords(saved, secretName(shown.entries, saved.secret)),
    );
    await f.answer(SAVED_DECISION_WORDS.removeConfirm, removing);
    expect((await f.settings.view()).rules).toEqual([]);
    expect((await run("deploy-2", ["--production"])).state).toBe("waiting");
  });

  it("keeps lock state honest and does not save a replacement into locked custody", async () => {
    const f = fixture();
    const original = (await f.settings.put(INPUT)).entries[0];
    if (!original) throw new Error("No entry to replace.");
    f.custody.state = "locked";
    const view = await f.settings.put({
      ...INPUT,
      expectedVersion: original.version,
      expectedRevision: original.revision,
      value: "must-not-replace",
    });
    expect(view.availability).toBe("locked");
    expect(view.entries[0]?.version).toBe(1);
    expect(view.message).toBe(SECRETS_WORDS.unavailable);
    f.custody.state = "open";
    expect((await f.settings.view()).availability).toBe("available");
  });

  it("leaves history until an explicit delete and makes old approval cards inert after restart", async () => {
    const f = fixture();
    await f.settings.put(INPUT);
    await f.request("waiting-at-quit");
    const previousCard = f.cards.at(-1);
    const reopened = f.make();
    let view = await reopened.view();
    expect(view.history[0]?.state).toBe("invalidated");
    expect(view.historyBytes).toBeGreaterThan(0);
    await f.click(SECRETS_WORDS.once, previousCard, reopened);
    expect(f.sent).toEqual([]);
    expect(f.confirms()).toBe(0);
    const exported = await reopened.exportHistory();
    expect(exported).toContain("waiting-at-quit");
    await reopened.action({ kind: "delete-history" });
    expect((await reopened.view()).history).toHaveLength(1);
    await f.answer(SECRET_QUESTION_WORDS.deleteHistory, undefined, reopened);
    view = await reopened.view();
    expect(view.history).toEqual([]);
  });
});

// Intent: INF-1109's approved scope, "device enrollment and the phone's approval
// screen for remote decisions" (docs/secrets.md, "Remote decisions"), built by
// INF-1202. The phone's key is a real P-256 key and every signature a real
// ECDSA one, so the home's own verifier decides; enrollment still needs the
// captain's fresh confirmation on this computer, which the stand-in answers.
describe("a phone's Secrets approvals", () => {
  const PHONE = "8F3C2A1E-5B7D-4C9A-9E21-0D4B6F8A7C35";
  const phoneKey = () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    return {
      privateKey: pair.privateKey,
      key: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    };
  };
  const signed = (privateKey: KeyObject, fields: Parameters<typeof decisionMessage>[0]): string =>
    sign("sha256", Buffer.from(decisionMessage(fields)), {
      key: privateKey,
      dsaEncoding: "der",
    }).toString("base64");
  const enrolled = async (f: ReturnType<typeof fixture>, key: string) => {
    await f.settings.enroll({ device: PHONE, label: "Kun’s iPhone", key });
    await f.click(SECRET_DEVICE_WORDS.confirm);
  };

  it("enrolls a phone only after the captain compares its code and confirms on this computer", async () => {
    const f = fixture();
    await f.settings.put(INPUT);
    const phone = phoneKey();
    const offered = await f.settings.enroll({
      device: PHONE,
      label: "Kun’s iPhone",
      key: phone.key,
    });
    expect(secretApprovalsSchema.parse(offered)).toMatchObject({ device: null, offered: true });
    const card = f.cards.at(-1);
    expect(card?.title).toBe(SECRET_DEVICE_WORDS.enrollTitle("Kun’s iPhone"));
    expect(card?.body).toContain(approvalCode(phone.key));
    expect((await f.settings.view()).devices).toEqual([]);

    f.confirmation(false);
    await f.click(SECRET_DEVICE_WORDS.confirm);
    expect((await f.settings.view()).devices).toEqual([]);
    expect((await f.settings.approvals(PHONE)).offered).toBe(false);

    f.confirmation(true);
    await enrolled(f, phone.key);
    expect((await f.settings.view()).devices).toEqual([
      { device: PHONE, label: "Kun’s iPhone", generation: 1, code: approvalCode(phone.key) },
    ]);
    expect((await f.settings.approvals(PHONE)).device).toEqual({
      label: "Kun’s iPhone",
      generation: 1,
      key: phone.key,
    });
  });

  // Intent: INF-1690 piece 4, the captain's pick: "In Devices, as a switch on the
  // paired iPhone: Approves key uses. The code comparison stays as the one
  // confirmation, with the same key underneath." The paired device is the one the
  // connection names for a view's request (`asAView`), as the dispatcher runs it.
  it("Devices' switch asks one paired phone for its key, which enrolls under that phone only through the code card", async () => {
    const f = fixture();
    await f.settings.put(INPUT);
    const phone = phoneKey();
    const PAIRED = "pocket-phone";
    expect(await asAView(() => f.settings.approvals(PHONE), { view: PAIRED })).toMatchObject({
      asked: false,
    });

    await f.settings.action({ kind: "ask-phone", paired: PAIRED });
    expect((await f.settings.view()).phones).toEqual([{ paired: PAIRED, state: "waiting" }]);
    // Only the phone the switch belongs to is asked.
    expect(
      (await asAView(() => f.settings.approvals(PHONE), { view: "another-phone" })).asked,
    ).toBe(false);
    expect((await asAView(() => f.settings.approvals(PHONE), { view: PAIRED })).asked).toBe(true);

    await asAView(
      () => f.settings.enroll({ device: PHONE, label: "Kun’s iPhone", key: phone.key }),
      { view: PAIRED },
    );
    const card = f.cards.at(-1);
    expect(card?.title).toBe(SECRET_DEVICE_WORDS.enrollTitle("Kun’s iPhone"));
    expect(card?.body).toContain(approvalCode(phone.key));
    expect((await f.settings.view()).phones).toEqual([
      { paired: PAIRED, state: "comparing", card: card?.id },
    ]);
    expect((await f.settings.view()).devices).toEqual([]);

    await f.click(SECRET_DEVICE_WORDS.confirm);
    const view = await f.settings.view();
    expect(view.phones).toEqual([]);
    expect(view.devices).toEqual([
      {
        device: PHONE,
        label: "Kun’s iPhone",
        generation: 1,
        code: approvalCode(phone.key),
        paired: PAIRED,
      },
    ]);
    expect((await asAView(() => f.settings.approvals(PHONE), { view: PAIRED })).asked).toBe(false);
    expect(f.confirms()).toBe(1);

    // Off asks once more, under the switch: the question that stops its approvals.
    await f.settings.action({ kind: "forget-device", device: PHONE });
    expect((await f.settings.view()).devices[0]?.stopping).toBe(true);
    await f.answer(SECRETS_WORDS.stopApprovals);
    expect((await f.settings.view()).devices).toEqual([]);
    expect(f.confirms()).toBe(2);
  });

  it("a key enrolled before the home linked it to a paired phone links through the same comparison", async () => {
    const f = fixture();
    await f.settings.put(INPUT);
    const phone = phoneKey();
    await enrolled(f, phone.key);
    const raised = f.cards.length;
    // The same key from the same unlinked request raises nothing.
    await f.settings.enroll({ device: PHONE, label: "Kun’s iPhone", key: phone.key });
    expect(f.cards).toHaveLength(raised);

    await f.settings.action({ kind: "ask-phone", paired: "pocket-phone" });
    await asAView(
      () => f.settings.enroll({ device: PHONE, label: "Kun’s iPhone", key: phone.key }),
      { view: "pocket-phone" },
    );
    expect(f.cards).toHaveLength(raised + 1);
    expect(f.cards.at(-1)?.body).not.toContain("This replaces");
    await f.click(SECRET_DEVICE_WORDS.confirm);
    expect((await f.settings.view()).devices).toEqual([
      {
        device: PHONE,
        label: "Kun’s iPhone",
        generation: 2,
        code: approvalCode(phone.key),
        paired: "pocket-phone",
      },
    ]);
  });

  it("turning the switch off before the code is confirmed takes the card down and enrolls nothing", async () => {
    const f = fixture();
    await f.settings.put(INPUT);
    await f.settings.action({ kind: "ask-phone", paired: "pocket-phone" });
    await asAView(
      () => f.settings.enroll({ device: PHONE, label: "Kun’s iPhone", key: phoneKey().key }),
      { view: "pocket-phone" },
    );
    const card = f.cards.at(-1);
    await f.settings.action({ kind: "cancel-phone", paired: "pocket-phone" });
    expect(f.withdrawn).toContain(card?.id);
    expect((await f.settings.view()).phones).toEqual([]);
    await f.click(SECRET_DEVICE_WORDS.confirm);
    expect((await f.settings.view()).devices).toEqual([]);
    expect(f.confirms()).toBe(0);
  });

  it("offers nothing before Secrets are set up, or for a key that is not a P-256 approval key", async () => {
    const f = fixture();
    const early = await f.settings.enroll({
      device: PHONE,
      label: "Kun’s iPhone",
      key: phoneKey().key,
    });
    expect(early).toMatchObject({ availability: "uninitialized", device: null, offered: false });
    expect(f.cards).toHaveLength(0);
    await f.settings.put(INPUT);
    const raised = f.cards.length;
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .publicKey.export({ format: "der", type: "spki" })
      .toString("base64");
    for (const key of [rsa, "bm90IGEga2V5"]) {
      const answer = await f.settings.enroll({ device: PHONE, label: "Kun’s iPhone", key });
      expect(answer).toMatchObject({ device: null, offered: false });
    }
    expect(f.cards).toHaveLength(raised);
  });

  it("runs the exact use on an enrolled phone's signed Allow and records it as remote", async () => {
    const f = fixture();
    await f.settings.put(INPUT);
    const phone = phoneKey();
    await enrolled(f, phone.key);
    const waiting = await f.request("phone-read", "planning-task");
    expect(waiting.state).toBe("waiting");
    const unenrolled = await f.settings.approvals("another-device");
    expect(unenrolled.waiting[0]?.nonce).toBeNull();

    const approvals = secretApprovalsSchema.parse(await f.settings.approvals(PHONE));
    const use = approvals.waiting[0];
    if (!use?.nonce || !approvals.home) throw new Error("No challenge for the enrolled phone.");
    // The phone's screen shows what the approval card shows.
    const card = f.cards.find((one) => one.id === use.card);
    expect(card?.title).toBe(
      SECRET_APPROVAL_CARD_WORDS.title(CALENDAR, TASK_TITLES["planning-task"] ?? null),
    );
    const shown = (await f.settings.view()).uses.find((one) => one.request === waiting.request);
    expect(use).toMatchObject({
      request: waiting.request,
      reason: shown?.reason,
      recipient: shown?.recipient,
      task: TASK_TITLES["planning-task"],
      facts: shown?.facts,
      // The phone names each secret as the card does (INF-3507's review): this lone one by its name alone.
      secrets: [
        {
          ref: INPUT.ref,
          label: INPUT.label,
          version: 1,
          environment: "Personal",
          name: INPUT.label,
        },
      ],
    });

    const decided = await f.settings.decideRemotely({
      kind: "allow",
      request: use.request,
      device: PHONE,
      generation: 1,
      nonce: use.nonce,
      signature: signed(phone.privateKey, {
        home: approvals.home,
        device: PHONE,
        generation: 1,
        request: use.request,
        digest: use.digest,
        nonce: use.nonce,
        expires: use.expires,
      }),
    });
    expect(["executing", "completed"]).toContain(decided.state);
    await vi.waitFor(() => expect(f.ended).toHaveLength(1));
    expect(f.ended[0]?.receipt.state).toBe("completed");
    expect(f.sent).toEqual([`Bearer ${TOKEN}`]);
    expect(f.withdrawn).toContain(use.card);
    const history = (await f.settings.view()).history.find((one) => one.request === use.request);
    expect(history).toMatchObject({ approval: "remote", device: PHONE, state: "completed" });
  });

  it("leaves the use waiting for a decision another key, generation or use signed", async () => {
    const f = fixture();
    await f.settings.put(INPUT);
    const phone = phoneKey();
    await enrolled(f, phone.key);
    const waiting = await f.request("phone-refused-read");
    const approvals = await f.settings.approvals(PHONE);
    const use = approvals.waiting[0];
    if (!use?.nonce || !approvals.home) throw new Error("No challenge for the enrolled phone.");
    const fields = {
      home: approvals.home,
      device: PHONE,
      generation: 1,
      request: use.request,
      digest: use.digest,
      nonce: use.nonce,
      expires: use.expires,
    };
    const allow = (signature: string, generation = 1) =>
      f.settings.decideRemotely({
        kind: "allow",
        request: use.request,
        device: PHONE,
        generation,
        nonce: use.nonce ?? "",
        signature,
      });
    expect((await allow(signed(phoneKey().privateKey, fields))).state).toBe("waiting");
    expect(
      (await allow(signed(phone.privateKey, { ...fields, digest: "0".repeat(64) }))).state,
    ).toBe("waiting");
    expect((await allow(signed(phone.privateKey, { ...fields, generation: 2 }), 2)).state).toBe(
      "waiting",
    );
    expect((await allow(signed(phone.privateKey, { ...fields, home: "another-home" }))).state).toBe(
      "waiting",
    );

    // A new key re-enrolls the same phone at the next generation; the old key no longer passes.
    const replacement = phoneKey();
    await enrolled(f, replacement.key);
    expect((await f.settings.view()).devices[0]?.generation).toBe(2);
    expect((await allow(signed(phone.privateKey, fields))).state).toBe("waiting");
    expect(f.sent).toEqual([]);
    expect(
      (await f.settings.view()).uses.find((one) => one.request === waiting.request)?.state,
    ).toBe("waiting");
  });

  it("takes a phone's refusal without a key and withdraws the approval card", async () => {
    const f = fixture();
    await f.settings.put(INPUT);
    const waiting = await f.request("phone-denied-read");
    const card = `card-secrets-use-${waiting.request}`;
    expect((await f.settings.approvals(PHONE)).waiting[0]?.card).toBe(card);
    expect(
      (await f.settings.decideRemotely({ kind: "deny", request: waiting.request })).state,
    ).toBe("denied");
    expect(f.withdrawn).toContain(card);
    expect((await f.settings.approvals(PHONE)).waiting).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  it("stops a phone's approvals only after the captain confirms on this computer", async () => {
    const f = fixture();
    await f.settings.put(INPUT);
    const phone = phoneKey();
    await enrolled(f, phone.key);
    const asked = (await f.settings.action({ kind: "forget-device", device: PHONE })).question;
    expect(asked?.title).toBe(SECRET_DEVICE_WORDS.stopTitle("Kun’s iPhone"));
    expect(asked?.about).toEqual({ kind: "device", device: PHONE });
    await f.answer(SECRET_DEVICE_WORDS.keep);
    expect((await f.settings.view()).devices).toHaveLength(1);
    expect(f.confirms()).toBe(1);
    await f.settings.action({ kind: "forget-device", device: PHONE });
    await f.answer(SECRETS_WORDS.stopApprovals);
    expect(f.confirms()).toBe(2);
    expect((await f.settings.view()).devices).toEqual([]);
    expect((await f.settings.approvals(PHONE)).device).toBeNull();
  });
});
