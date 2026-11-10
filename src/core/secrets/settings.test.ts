import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import {
  SECRET_DEVICE_WORDS,
  SECRETS_RECOVERY_WORDS,
  SECRETS_WORDS,
  type SecretEntryInput,
  secretApprovalsSchema,
  secretsViewSchema,
} from "@shared/secrets";
import { describe, expect, it, vi } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { HostSecretsRecovery } from "../host";
import { approvalCode, decisionMessage } from "./approvals";
import { httpSecretBroker } from "./httpBroker";
import { ProtectedSecrets } from "./protected";
import { SHORT_READ_USES } from "./readAccess";
import type { RecoveryFiles } from "./recoveryArchive";
import type { EndedUseReceipt } from "./requests";
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
  return {
    settings,
    make,
    broker,
    cards,
    withdrawn,
    ended,
    click,
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
      await f.click("Delete history");
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
    await settings.action({ kind: "forget", ref: INPUT.ref });
    const oldOffer = f.cards.at(-1);
    const restored = await settings.action({ kind: "restore-recovery" });
    expect(restored.message).toBe(SECRETS_RECOVERY_WORDS.restore.restored);
    expect(restored.home).not.toBe(original.home);
    expect(restored.entries[0]?.label).toBe(INPUT.label);
    expect(restored.entries[0]?.revision).not.toBe(original.entries[0]?.revision);
    expect(secretsViewSchema.safeParse(restored).success).toBe(true);
    expect(JSON.stringify(restored)).not.toContain(TOKEN);
    expect(selected?.archive.every((byte) => byte === 0)).toBe(true);
    expect(selected?.key.every((byte) => byte === 0)).toBe(true);
    await f.click("Forget secret", oldOffer, settings);
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
    expect(f.cards.at(-1)?.title).toBe(SECRETS_WORDS.approvalTitle);
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
    expect(approvals.waiting.find((one) => one.request === receipt.request)?.secrets).toEqual(
      requested,
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
    ).toEqual(requested);
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
    await f.click("Forget secret");
    const recreated = await f.settings.put({ ...INPUT, label: "New planning credential" });
    expect(recreated.entries[0]?.version).toBe(original.version);
    const refused = await f.settings.put(staleForm);
    expect(refused.message).toBe(SECRETS_WORDS.stale);
    expect(refused.entries).toEqual(recreated.entries);
    await f.request("after-stale-replacement");
    await f.click(SECRETS_WORDS.once);
    expect(f.sent).toEqual([`Bearer ${TOKEN}`]);
  });

  it("a Forget offer cannot delete a different entry that reused its displayed version", async () => {
    // INF-1109's trusted deletion must keep the exact entry the person reviewed.
    const f = fixture();
    await f.settings.put(INPUT);
    await f.settings.action({ kind: "forget", ref: INPUT.ref });
    const oldOffer = f.cards.at(-1);
    await (await f.owner()).forgetSecret(INPUT.ref);
    const recreated = await f.settings.put({ ...INPUT, label: "New planning credential" });
    await f.click("Forget secret", oldOffer);
    expect((await f.settings.view()).entries).toEqual(recreated.entries);
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

  it("edits no rule from its form: the exact shown rules need a fresh host confirmation", async () => {
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
    await f.settings.action({ kind: "save-rules", rules });
    expect((await f.settings.view()).rules).toEqual([]);
    f.confirmation(false);
    await f.click("Confirm and save");
    expect((await f.settings.view()).rules).toEqual([]);
    f.confirmation(true);
    await f.settings.action({ kind: "save-rules", rules });
    await f.click("Confirm and save");
    expect((await f.settings.view()).rules).toEqual(rules);
    expect((await f.request("forbidden-read")).state).toBe("denied");
    expect(f.sent).toEqual([]);
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
    await f.click("Delete history", f.cards.at(-1), reopened);
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
    expect(card?.title).toBe(SECRETS_WORDS.approvalTitle);
    const shown = (await f.settings.view()).uses.find((one) => one.request === waiting.request);
    expect(use).toMatchObject({
      request: waiting.request,
      reason: shown?.reason,
      recipient: shown?.recipient,
      facts: shown?.facts,
      secrets: [{ ref: INPUT.ref, label: INPUT.label, version: 1, environment: "Personal" }],
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
    await f.settings.action({ kind: "forget-device", device: PHONE });
    expect(f.cards.at(-1)?.title).toBe(SECRET_DEVICE_WORDS.stopTitle("Kun’s iPhone"));
    await f.click(SECRET_DEVICE_WORDS.keep);
    expect((await f.settings.view()).devices).toHaveLength(1);
    await f.settings.action({ kind: "forget-device", device: PHONE });
    await f.click(SECRETS_WORDS.stopApprovals);
    expect((await f.settings.view()).devices).toEqual([]);
    expect((await f.settings.approvals(PHONE)).device).toBeNull();
  });
});
