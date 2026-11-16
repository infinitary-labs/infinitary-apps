import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import { SECRET_ASK_CARD_WORDS, secretKeepFields } from "@shared/secrets";
import { describe, expect, it } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { SecretAskEnded } from "./asks";
import { SECRET_ASK_WORDS } from "./commandWords";
import { ProtectedSecrets } from "./protected";
import { SecretsSettings } from "./settings";

// Intent: INF-4239's direction A, the captain's pick: an agent asks by name,
// place and reason; Infinitary draws its own masked field; the value goes
// straight into Secrets and the asker hears only the reference, name, place
// and version. Also chosen: an ask may replace a kept secret, naming it and
// its version; one card asks for several secrets, kept with one click. The
// spec: the ask answers at once (waiting, kept, unavailable), a spent or
// stale pass does nothing, a locked store shows Unlock on the card.
// Custody is the disposable stand-in; the native stores' own probes prove them.
const VALUE = "sk_test_invented_ask_value_4239";
type Raised = Omit<Card, "author" | "priority" | "status" | "createdAt">;

function fixture(options: { asksFile?: string; taskOpen?: (task: string) => boolean } = {}) {
  const custody = disposableCustody();
  const dir = scratchDir("secret-asks-");
  const cards: Raised[] = [];
  const withdrawn: string[] = [];
  const heard: { task: string | null; ended: SecretAskEnded }[] = [];
  let unlocks = 0;
  let opens = 0;
  const make = () =>
    new SecretsSettings({
      open: (initialize) => {
        opens += 1;
        return ProtectedSecrets.open({
          dir,
          custody,
          initialize,
          environment: () => ({}),
          now: () => 1000,
          authentication: { available: async () => true, confirm: async () => true },
        });
      },
      unlock: async () => {
        unlocks += 1;
        custody.state = "open";
        return true;
      },
      raise: (card) => {
        cards.push(card);
      },
      withdraw: (id) => {
        withdrawn.push(id);
      },
      changed: () => {},
      asked: (task, ended) => {
        heard.push({ task, ended });
      },
      taskTitle: () => "Wire up the checkout",
      ...(options.asksFile ? { asksFile: options.asksFile } : {}),
      ...(options.taskOpen ? { taskOpen: options.taskOpen } : {}),
      now: () => 1000,
    });
  const settings = make();
  /** The Keep in Secrets button of the newest ask card, read as the window reads it. */
  const keepOf = (card = cards.at(-1)) => {
    if (!card) throw new Error("No card was raised.");
    const keep = secretKeepFields({ ...card, author: "host" });
    if (!keep) throw new Error("The card asks for no secret.");
    return keep;
  };
  const press = async (label: string, card = cards.at(-1), controller = settings) => {
    const effect = card?.actions.find((action) => action.label === label)?.effect;
    if (effect?.kind !== "host" || effect.op !== "secrets-decision" || !effect.arg)
      throw new Error("No trusted action with that label.");
    await controller.decide(effect.arg);
  };
  return {
    settings,
    make,
    custody,
    dir,
    cards,
    withdrawn,
    heard,
    keepOf,
    press,
    unlocks: () => unlocks,
    opens: () => opens,
  };
}

const STRIPE = { name: "Stripe test key", place: "Test" };

describe("asking to keep a secret", () => {
  it("raises Infinitary's own card with one masked field per secret and keeps both with one click", async () => {
    const f = fixture();
    const answer = await f.settings.askToKeep("task-a", {
      id: "checkout",
      reason: "Charge the test card in the checkout tests",
      secrets: [STRIPE, { name: "Webhook secret" }],
    });
    expect(answer).toEqual({ ask: "checkout", state: "waiting" });
    const card = f.cards.at(-1);
    expect(card?.taskId).toBe("task-a");
    const keep = f.keepOf();
    expect(keep.fields.map((field) => [field.name, field.place])).toEqual([
      ["Stripe test key", "Test"],
      ["Webhook secret", undefined],
    ]);
    const kept = await f.settings.keep({
      pass: keep.pass,
      values: [
        { field: keep.fields[0]?.id ?? "", value: VALUE },
        { field: keep.fields[1]?.id ?? "", value: "whsec_invented" },
      ],
    });
    expect(kept).toEqual({ kept: true });
    // The asker hears names, places, references and versions once: never a value.
    expect(f.heard).toHaveLength(1);
    const ended = f.heard[0]?.ended;
    expect(ended?.state).toBe("kept");
    if (ended?.state !== "kept") throw new Error("Not kept.");
    expect(ended.secrets.map(({ name, place, version }) => ({ name, place, version }))).toEqual([
      { name: "Stripe test key", place: "Test", version: 1 },
      { name: "Webhook secret", place: "", version: 1 },
    ]);
    expect(JSON.stringify(f.heard)).not.toContain(VALUE);
    expect(f.withdrawn).toContain(card?.id);
    const listed = (await f.settings.view()).entries.map((entry) => [
      entry.label,
      entry.environment,
    ]);
    expect(listed).toEqual(
      expect.arrayContaining([
        ["Stripe test key", "Test"],
        ["Webhook secret", ""],
      ]),
    );
    // The value lives only inside the sealed record: no file in Secrets' folder holds it plainly.
    for (const name of await readdir(f.dir, { recursive: true })) {
      const bytes = await readFile(join(f.dir, name)).catch(() => undefined);
      if (bytes) expect(bytes.includes(Buffer.from(VALUE))).toBe(false);
    }
  });

  it("answers kept at once, with the reference, when every secret is already kept there", async () => {
    const f = fixture();
    await f.settings.askToKeep("task-a", { id: "first", reason: "Tests", secrets: [STRIPE] });
    const keep = f.keepOf();
    await f.settings.keep({ pass: keep.pass, values: [{ field: "s1", value: VALUE }] });
    const raised = f.cards.length;
    const again = await f.settings.askToKeep("task-b", {
      id: "second",
      reason: "Tests",
      secrets: [STRIPE],
    });
    expect(again.state).toBe("kept");
    if (again.state !== "kept") throw new Error("Not kept.");
    expect(again.secrets).toEqual([
      { ref: expect.any(String), name: "Stripe test key", place: "Test", version: 1 },
    ]);
    expect(f.cards).toHaveLength(raised);
  });

  it("answers unavailable where Secrets is not offered, and raises nothing", async () => {
    const cards: Raised[] = [];
    const settings = new SecretsSettings({
      raise: (card) => {
        cards.push(card);
      },
      withdraw: () => {},
      changed: () => {},
    });
    const answer = await settings.askToKeep(null, { id: "a", reason: "r", secrets: [STRIPE] });
    expect(answer).toEqual({ ask: "a", state: "unavailable", help: SECRET_ASK_WORDS.notOffered });
    expect(cards).toEqual([]);
  });

  it("refuses an ask with no reason, no secret, or a value in it", async () => {
    const f = fixture();
    await expect(
      f.settings.askToKeep(null, { id: "a", reason: " ", secrets: [STRIPE] }),
    ).rejects.toThrow();
    await expect(
      f.settings.askToKeep(null, { id: "a", reason: "r", secrets: [] }),
    ).rejects.toThrow();
    await expect(
      f.settings.askToKeep(null, {
        id: "a",
        reason: "r",
        secrets: [{ ...STRIPE, value: VALUE } as never],
      }),
    ).rejects.toThrow();
    expect(f.cards).toEqual([]);
  });

  it("a spent pass, a missing value or a Keep sent as a card choice keeps nothing", async () => {
    const f = fixture();
    await f.settings.askToKeep("task-a", { id: "a", reason: "Tests", secrets: [STRIPE] });
    const keep = f.keepOf();
    expect(
      await f.settings.keep({ pass: keep.pass, values: [{ field: "s1", value: "" }] }),
    ).toEqual({ kept: false, words: SECRET_ASK_CARD_WORDS.empty });
    // A card choice cannot spend Keep: only the window's own request carries values.
    await f.settings.decide(keep.pass);
    expect(f.heard).toEqual([]);
    expect(
      await f.settings.keep({ pass: keep.pass, values: [{ field: "s1", value: VALUE }] }),
    ).toEqual({ kept: true });
    expect(
      await f.settings.keep({ pass: keep.pass, values: [{ field: "s1", value: VALUE }] }),
    ).toEqual({ kept: false, words: SECRET_ASK_CARD_WORDS.gone });
    expect((await f.settings.view()).entries.filter((e) => e.label === STRIPE.name)).toHaveLength(
      1,
    );
  });

  it("Don't keep ends the ask, and the asker hears not-kept once", async () => {
    const f = fixture();
    await f.settings.askToKeep(null, { id: "a", reason: "Tests", secrets: [STRIPE] });
    const keep = f.keepOf();
    await f.press(SECRET_ASK_CARD_WORDS.dontKeep);
    expect(f.heard).toEqual([{ task: null, ended: { ask: "a", state: "not-kept" } }]);
    expect(
      await f.settings.keep({ pass: keep.pass, values: [{ field: "s1", value: VALUE }] }),
    ).toEqual({ kept: false, words: SECRET_ASK_CARD_WORDS.gone });
  });

  it("replaces a kept secret named by its version, and asks again when it changed since", async () => {
    const f = fixture();
    await f.settings.askToKeep("task-a", { id: "first", reason: "Tests", secrets: [STRIPE] });
    await f.settings.keep({ pass: f.keepOf().pass, values: [{ field: "s1", value: "one" }] });
    const ended = f.heard[0]?.ended;
    if (ended?.state !== "kept") throw new Error("Not kept.");
    const ref = ended.secrets[0]?.ref ?? "";
    await f.settings.askToKeep("task-a", {
      id: "rotate",
      reason: "The old key was revoked",
      secrets: [{ replace: ref }],
    });
    const offer = f.keepOf();
    expect(offer.fields[0]?.replaces).toEqual({ ref, version: 1 });
    // Settings replaces it meanwhile: the card's Keep would overwrite a version it did not name.
    const entry = (await f.settings.view()).entries.find((one) => one.ref === ref);
    await f.settings.put({
      ref,
      label: STRIPE.name,
      value: "two",
      expectedVersion: entry?.version ?? 1,
      expectedRevision: entry?.revision ?? null,
      environment: "Test",
    });
    expect(
      await f.settings.keep({ pass: offer.pass, values: [{ field: "s1", value: "three" }] }),
    ).toEqual({ kept: false, words: SECRET_ASK_CARD_WORDS.stale });
    const renewed = f.keepOf();
    expect(renewed.fields[0]?.replaces).toEqual({ ref, version: 2 });
    expect(
      await f.settings.keep({ pass: renewed.pass, values: [{ field: "s1", value: "three" }] }),
    ).toEqual({ kept: true });
    expect(f.heard.at(-1)?.ended).toEqual({
      ask: "rotate",
      state: "kept",
      secrets: [{ ref, name: STRIPE.name, place: "Test", version: 3 }],
    });
  });

  it("a locked store leaves the card up with Unlock, and keeps once unlocked", async () => {
    const f = fixture();
    // An owner already open, with a secret kept, locks under it.
    await f.settings.put({
      ref: "webhook",
      label: "Webhook secret",
      value: "whsec_invented",
      expectedVersion: 0,
      expectedRevision: null,
      environment: "",
    });
    await f.settings.askToKeep("task-a", { id: "a", reason: "Tests", secrets: [STRIPE] });
    const opened = f.opens();
    f.custody.state = "locked";
    const first = f.keepOf();
    expect(
      await f.settings.keep({ pass: first.pass, values: [{ field: "s1", value: VALUE }] }),
    ).toEqual({ kept: false, words: SECRET_ASK_CARD_WORDS.locked });
    // Keep's answer says why where it was pressed; the card's body does not say it again.
    expect(f.cards.at(-1)?.body).not.toContain(SECRET_ASK_CARD_WORDS.locked);
    expect(f.cards.at(-1)?.actions.map((action) => action.label)).toEqual([
      SECRET_ASK_CARD_WORDS.dontKeep,
      SECRET_ASK_CARD_WORDS.unlock,
      SECRET_ASK_CARD_WORDS.keep,
    ]);
    await f.press(SECRET_ASK_CARD_WORDS.unlock);
    expect(f.unlocks()).toBe(1);
    const after = f.keepOf();
    expect(after.pass).not.toBe(first.pass);
    expect(
      await f.settings.keep({ pass: after.pass, values: [{ field: "s1", value: VALUE }] }),
    ).toEqual({ kept: true });
    // The owner that was open stays the one in use: its waiting and running uses are not dropped.
    expect(f.opens()).toBe(opened);
  });

  it("a waiting ask comes back after a restart with a new pass; the old one does nothing", async () => {
    const asksFile = join(scratchDir("secret-asks-book-"), "secret-asks.json");
    const f = fixture({ asksFile });
    await f.settings.askToKeep("task-a", { id: "a", reason: "Tests", secrets: [STRIPE] });
    const before = f.keepOf();
    expect(await readFile(asksFile, "utf8")).not.toContain(VALUE);
    const restarted = f.make();
    restarted.resumeAsks();
    const after = f.keepOf();
    expect(after.pass).not.toBe(before.pass);
    expect(
      await restarted.keep({ pass: before.pass, values: [{ field: "s1", value: VALUE }] }),
    ).toEqual({ kept: false, words: SECRET_ASK_CARD_WORDS.gone });
    expect(
      await restarted.keep({ pass: after.pass, values: [{ field: "s1", value: VALUE }] }),
    ).toEqual({ kept: true });
  });

  it("an ask from a task that closed keeps nothing and is withdrawn", async () => {
    let open = true;
    const f = fixture({ taskOpen: () => open });
    await f.settings.askToKeep("task-a", { id: "a", reason: "Tests", secrets: [STRIPE] });
    const keep = f.keepOf();
    open = false;
    expect(
      await f.settings.keep({ pass: keep.pass, values: [{ field: "s1", value: VALUE }] }),
    ).toEqual({ kept: false, words: SECRET_ASK_CARD_WORDS.closed });
    expect(f.heard.at(-1)?.ended).toEqual({
      ask: "a",
      state: "withdrawn",
      why: SECRET_ASK_WORDS.closed,
    });
    expect((await f.settings.view()).entries).toEqual([]);
  });

  it("the asker's cancel withdraws its card and tells nobody", async () => {
    const f = fixture();
    await f.settings.askToKeep(null, { id: "a", reason: "Tests", secrets: [STRIPE] });
    const card = f.cards.at(-1);
    expect(f.settings.cancelAsk(null, "a")).toBe(true);
    expect(f.withdrawn).toContain(card?.id);
    expect(f.heard).toEqual([]);
    expect(f.settings.cancelAsk(null, "a")).toBe(false);
  });
});
