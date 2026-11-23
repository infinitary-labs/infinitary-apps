import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SECRETS_WORDS } from "@shared/secrets";
import { describe, expect, it } from "vitest";
import {
  type DisposableCustody,
  disposableCustody,
} from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { RECORD_ROOTS } from "../homeMove/record";
import { httpSecretBroker } from "../secrets/httpBroker";
import { ProtectedSecrets } from "../secrets/protected";
import { SecretsSettings } from "../secrets/settings";
import { readStandbyLock, StandbyLockKeeper } from "./lock";
import {
  openKeyWith,
  readSealedSecrets,
  readStandbyLocks,
  SEALED_SECRETS_FILE,
  STANDBY_LOCKS_FILE,
  sealKeyTo,
  writeSealedSecrets,
  writeStandbyLocks,
} from "./sealedSecrets";
import { StandbySecrets } from "./secrets";
import { STANDBY_WORDS } from "./words";

// Intent: piece 10 of INF-4207's approved plan (decision 10, "Secret values on
// a standby: yes, sealed, opened with that standby's own lock after the
// captain confirms on it"): each computer that keeps a copy receives the
// values sealed, opens them only with its own lock once the person confirmed
// there, a changed secret reaches it like any other change, and a first mate
// that starts there from the copy runs an approved use with no restore by
// hand. Native custody and the person's confirmation are stand-ins; the real
// owner, archive, sealing and record files run.
const TOKEN = "ya29.invented-standby-token";
const CHANGED = "ya29.invented-standby-token-changed";

type Computer = {
  id: string;
  /** Its own Secrets' custody, as the first mate there would use. */
  secretsCustody: DisposableCustody;
  /** Its own lock's custody, the work mode's and the first mate's alike. */
  lockCustody: DisposableCustody;
  confirms: number;
  confirmation: boolean;
  keeper: StandbyLockKeeper;
};

function computer(id: string): Computer {
  const one: Computer = {
    id,
    secretsCustody: disposableCustody(),
    lockCustody: disposableCustody(),
    confirms: 0,
    confirmation: true,
    keeper: undefined as unknown as StandbyLockKeeper,
  };
  one.keeper = new StandbyLockKeeper(
    {
      custody: one.lockCustody,
      authentication: {
        available: async () => true,
        confirm: async () => {
          one.confirms += 1;
          return one.confirmation;
        },
      },
    },
    () => {},
  );
  return one;
}

/** A first mate's Secrets on one computer, as Settings drives them, with a calendar broker that records what it sends. */
function home(custody: DisposableCustody) {
  const dir = scratchDir("standby-secrets-home-");
  const sent: string[] = [];
  const cards: { actions: { label: string; effect?: unknown }[] }[] = [];
  /** What hears Secrets change here, as the copies' sealing does in the app. */
  const hooks = { changed: () => {} };
  /** The person's answer to this computer's own confirmation, and each reason it asked. */
  const confirmation = { answer: true, reasons: [] as string[] };
  const settings = new SecretsSettings({
    open: (initialize) =>
      ProtectedSecrets.open({
        dir,
        custody,
        initialize,
        environment: () => ({}),
        authentication: {
          available: async () => true,
          confirm: async (reason) => {
            confirmation.reasons.push(reason);
            return confirmation.answer;
          },
        },
      }),
    raise: (card) => {
      cards.push(card);
    },
    withdraw: () => {},
    changed: () => hooks.changed(),
    taskTitle: () => "Plan the week",
  });
  settings.registerBroker(
    httpSecretBroker({
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
        return new Response(JSON.stringify({ items: [] }), {
          headers: { "content-type": "application/json" },
        });
      },
    }),
  );
  const put = async (value: string) => {
    const current = (await settings.view()).entries.find((entry) => entry.ref === "calendar");
    await settings.put({
      ref: "calendar",
      label: "Planning calendar",
      value,
      expectedVersion: current?.version ?? 0,
      expectedRevision: current?.revision ?? null,
      environment: "Personal",
    });
  };
  const use = async (id: string) => {
    const receipt = await settings.broker({
      id,
      reason: "Read my next planning meeting",
      broker: "calendar",
      input: { calendar: "primary" },
    });
    const effect = cards.at(-1)?.actions.find((a) => a.label === SECRETS_WORDS.once)?.effect as
      | { kind: string; op: string; arg?: string }
      | undefined;
    if (effect?.kind !== "host" || !effect.arg) throw new Error("No Allow once on the card.");
    await settings.decide(effect.arg);
    await settings.takeBrokerResult(receipt.request);
  };
  const choose = async (label: string) => {
    const action = cards
      .findLast((card) => card.actions.some((a) => a.label === label))
      ?.actions.find((a) => a.label === label);
    const effect = action?.effect as { kind: string; arg?: string } | undefined;
    if (effect?.kind !== "host" || !effect.arg) throw new Error(`No ${label} on a card.`);
    await settings.decide(effect.arg);
  };
  return { settings, sent, put, use, hooks, cards, choose, confirmation };
}

function standbySecrets(
  userData: string,
  settings: SecretsSettings,
  listed: Computer[],
  ownLock?: DisposableCustody,
) {
  const byId = new Map(listed.map((each) => [each.id, each]));
  return new StandbySecrets({
    userData,
    secrets: settings,
    ownLock,
    speaks: () => true,
    ask: (deviceId, _channel, args) => {
      const there = byId.get(deviceId);
      if (!there) throw new Error("out of reach");
      return there.keeper.answer(args);
    },
    listed: () => [...byId.keys()],
    changed: () => {},
    log: () => {},
    pollMs: 5,
  });
}

/** Until a computer's line says it keeps the secrets, as Settings reads it again. */
async function kept(standbys: StandbySecrets, deviceId: string): Promise<void> {
  while (standbys.state(deviceId) !== "kept") await new Promise((done) => setTimeout(done, 5));
}

/** The record as a copy holds it: every record root the stream carries, laid out the same. */
function copyRecord(from: string): string {
  const to = scratchDir("standby-secrets-copy-");
  for (const root of RECORD_ROOTS) {
    const source = join(from, ...root.split("/"));
    if (!existsSync(source)) continue;
    const target = join(to, ...root.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
  return to;
}

describe("Secrets on a computer that keeps a copy", () => {
  it("seals each change to the confirmed computer's lock alone, and a takeover there runs an approved use", async () => {
    const mini = computer("mini");
    const laptop = computer("laptop");
    const oldHome = home(disposableCustody());
    const userData = scratchDir("standby-secrets-record-");
    await oldHome.put(TOKEN);
    const standbys = standbySecrets(userData, oldHome.settings, [mini, laptop]);

    // Nothing is kept anywhere before the person confirms there.
    await standbys.seal();
    expect(readSealedSecrets(userData)).toBeUndefined();

    expect(await standbys.keep("mini")).toBe("asking");
    await kept(standbys, "mini");
    expect(mini.confirms).toBe(1);
    const first = readSealedSecrets(userData);
    expect(first?.keys.map((each) => each.device)).toEqual(["mini"]);
    expect(readStandbyLocks(userData).locks.map((each) => each.device)).toEqual(["mini"]);

    expect(laptop.confirms).toBe(0);
    expect(await readStandbyLock(laptop.lockCustody)).toBeUndefined();
    expect(standbys.state("laptop")).toBe("none");

    await oldHome.put(CHANGED);
    await standbys.seal();
    const changed = readSealedSecrets(userData);
    expect(changed?.archive).not.toBe(first?.archive);
    const held = await readStandbyLock(mini.lockCustody);
    if (!held || held === "unavailable") throw new Error("The mini kept no lock.");
    const key = changed && openKeyWith(held, changed);
    expect(key?.length).toBe(32);
    key?.fill(0);
    await standbys.seal();
    expect(readSealedSecrets(userData)?.at).toBe(changed?.at);
    standbys.dispose();

    const newRecord = copyRecord(userData);
    const newHome = home(mini.secretsCustody);
    const taken = standbySecrets(newRecord, newHome.settings, [laptop], mini.lockCustody);
    await taken.adopt();
    await newHome.use("after-takeover");
    expect(newHome.sent).toEqual([`Bearer ${CHANGED}`]);
    // Saved decisions start empty there, as after a restore.
    expect((await newHome.settings.view()).rules).toEqual([]);
    // It is the home now: its own lock left the list, and with no other lock nothing stays sealed.
    expect(readStandbyLocks(newRecord).locks).toEqual([]);
    expect(readSealedSecrets(newRecord)).toBeUndefined();
    taken.dispose();
  });

  it("a computer whose confirmation is refused keeps nothing", async () => {
    const mini = computer("mini");
    mini.confirmation = false;
    const oldHome = home(disposableCustody());
    const userData = scratchDir("standby-secrets-record-");
    await oldHome.put(TOKEN);
    const standbys = standbySecrets(userData, oldHome.settings, [mini]);
    expect(await standbys.keep("mini")).toBe("asking");
    while (standbys.state("mini") === "asking") await new Promise((done) => setTimeout(done, 5));
    expect(standbys.state("mini")).toBe("none");
    expect(await readStandbyLock(mini.lockCustody)).toBeUndefined();
    expect(readSealedSecrets(userData)).toBeUndefined();
    standbys.dispose();
  });

  /** A home with Secrets of its own that starts from the copy the old home sealed to it and to the laptop. */
  async function startedWithOwn() {
    const mini = computer("mini");
    const laptop = computer("laptop");
    const oldHome = home(disposableCustody());
    const userData = scratchDir("standby-secrets-record-");
    await oldHome.put(TOKEN);
    const standbys = standbySecrets(userData, oldHome.settings, [mini, laptop]);
    await standbys.keep("mini");
    await kept(standbys, "mini");
    await standbys.keep("laptop");
    await kept(standbys, "laptop");
    standbys.dispose();

    const newHome = home(mini.secretsCustody);
    await newHome.put(CHANGED);
    const record = copyRecord(userData);
    const sealed = readSealedSecrets(record);
    const taken = standbySecrets(record, newHome.settings, [laptop], mini.lockCustody);
    newHome.hooks.changed = () => void taken.seal();
    await taken.adopt();
    return { mini, laptop, newHome, record, sealed, taken };
  }

  it("a first mate that starts from a copy with Secrets of its own keeps both and asks on one card which to use", async () => {
    const { newHome, record, sealed, taken } = await startedWithOwn();
    expect(newHome.cards.at(-1)?.actions.map((action) => action.label)).toEqual([
      STANDBY_WORDS.whichCopy,
      STANDBY_WORDS.whichOwn,
    ]);
    await newHome.use("own-value");
    expect(newHome.sent).toEqual([`Bearer ${CHANGED}`]);
    await newHome.put(`${CHANGED}-again`);
    await taken.seal();
    await taken.sweep();
    expect(readSealedSecrets(record)).toEqual(sealed);
    taken.dispose();
  });

  it("choosing the copy's Secrets asks this computer's confirmation, and a refusal keeps both sets", async () => {
    const { newHome, record, sealed, taken } = await startedWithOwn();
    const asked = newHome.confirmation.reasons.length;
    newHome.confirmation.answer = false;
    await newHome.choose(STANDBY_WORDS.whichCopy);
    expect(newHome.confirmation.reasons.length).toBe(asked + 1);
    newHome.confirmation.answer = true;
    await newHome.use("own-value");
    expect(newHome.sent).toEqual([`Bearer ${CHANGED}`]);
    expect(readSealedSecrets(record)).toEqual(sealed);
    taken.dispose();
  });

  it("choosing the copy's Secrets takes them here and seals them for the other copies", async () => {
    const { newHome, record, sealed, taken } = await startedWithOwn();
    const asked = newHome.confirmation.reasons.length;
    await newHome.choose(STANDBY_WORDS.whichCopy);
    expect(newHome.confirmation.reasons.length).toBe(asked + 1);
    await taken.seal();
    await newHome.use("copy-value");
    expect(newHome.sent).toEqual([`Bearer ${TOKEN}`]);
    expect(readSealedSecrets(record)?.source).not.toBe(sealed?.source);
    expect(readSealedSecrets(record)?.keys.map((each) => each.device)).toEqual(["laptop"]);
    taken.dispose();
  });

  it("keeping this computer's Secrets seals them for the other copies, and a later start does not ask again", async () => {
    const { mini, laptop, newHome, record, sealed, taken } = await startedWithOwn();
    await newHome.choose(STANDBY_WORDS.whichOwn);
    await taken.seal();
    await newHome.use("own-value");
    expect(newHome.sent).toEqual([`Bearer ${CHANGED}`]);
    const now = readSealedSecrets(record);
    expect(now?.source).not.toBe(sealed?.source);
    expect(now?.keys.map((each) => each.device)).toEqual(["laptop"]);
    taken.dispose();

    // The app stopped before that sealing reached the copy: the next start knows the choice.
    if (sealed) writeSealedSecrets(record, sealed);
    const asked = newHome.cards.length;
    const next = standbySecrets(record, newHome.settings, [laptop], mini.lockCustody);
    await next.adopt();
    expect(newHome.cards.length).toBe(asked);
    expect(readSealedSecrets(record)?.source).not.toBe(sealed?.source);
    next.dispose();
  });

  it("keeping this computer's Secrets while its lock's store is locked seals them at the next change once it opens", async () => {
    const { mini, newHome, record, sealed, taken } = await startedWithOwn();
    mini.lockCustody.state = "locked";
    await newHome.choose(STANDBY_WORDS.whichOwn);
    await taken.seal();
    expect(readSealedSecrets(record)).toEqual(sealed);
    mini.lockCustody.state = "open";
    await taken.seal();
    expect(readSealedSecrets(record)?.source).not.toBe(sealed?.source);
    expect(readSealedSecrets(record)?.keys.map((each) => each.device)).toEqual(["laptop"]);
    await newHome.use("own-value");
    expect(newHome.sent).toEqual([`Bearer ${CHANGED}`]);
    taken.dispose();
  });

  it("a start whose own lock's store is locked leaves the copy's values sealed, and takes them at the next change once it opens", async () => {
    const mini = computer("mini");
    const laptop = computer("laptop");
    const oldHome = home(disposableCustody());
    const userData = scratchDir("standby-secrets-record-");
    await oldHome.put(TOKEN);
    const standbys = standbySecrets(userData, oldHome.settings, [mini, laptop]);
    await standbys.keep("mini");
    await kept(standbys, "mini");
    await standbys.keep("laptop");
    await kept(standbys, "laptop");
    standbys.dispose();

    const record = copyRecord(userData);
    const sealed = readSealedSecrets(record);
    const newHome = home(mini.secretsCustody);
    mini.lockCustody.state = "locked";
    const taken = standbySecrets(record, newHome.settings, [laptop], mini.lockCustody);
    newHome.hooks.changed = () => void taken.seal();
    await taken.adopt();
    await taken.sweep();
    await taken.seal();
    expect(readSealedSecrets(record)).toEqual(sealed);

    mini.lockCustody.state = "open";
    await taken.seal();
    await newHome.use("after-retry");
    expect(newHome.sent).toEqual([`Bearer ${TOKEN}`]);
    expect(readSealedSecrets(record)?.source).not.toBe(sealed?.source);
    expect(readSealedSecrets(record)?.keys.map((each) => each.device)).toEqual(["laptop"]);
    taken.dispose();
  });

  it("a taking that fails tries once, not again for the change it announced itself", async () => {
    const mini = computer("mini");
    const laptop = computer("laptop");
    const oldHome = home(disposableCustody());
    const userData = scratchDir("standby-secrets-record-");
    await oldHome.put(TOKEN);
    const standbys = standbySecrets(userData, oldHome.settings, [mini, laptop]);
    await standbys.keep("mini");
    await kept(standbys, "mini");
    await standbys.keep("laptop");
    await kept(standbys, "laptop");
    standbys.dispose();

    const record = copyRecord(userData);
    const sealed = readSealedSecrets(record);
    const newHome = home(mini.secretsCustody);
    // A use is under way here: the taking answers busy and, as Settings does, announces a change.
    let tries = 0;
    const taken = new StandbySecrets({
      userData: record,
      secrets: {
        sealedState: () => newHome.settings.sealedState(),
        sealForStandbys: (seal) => newHome.settings.sealForStandbys(seal),
        adoptStandby: async () => {
          tries += 1;
          newHome.hooks.changed();
          return "busy";
        },
        offer: (...args) => newHome.settings.offer(...args),
      },
      ownLock: mini.lockCustody,
      speaks: () => true,
      ask: (_deviceId, _channel, args) => laptop.keeper.answer(args),
      listed: () => ["laptop"],
      changed: () => {},
      log: () => {},
    });
    newHome.hooks.changed = () => void taken.seal();
    await taken.adopt();
    // The seal the taking's own change asked for runs before this sweep, and tries nothing again.
    await taken.sweep();
    expect(tries).toBe(1);
    // A change from outside the taking tries once more.
    await taken.seal();
    expect(tries).toBe(2);
    expect(readSealedSecrets(record)).toEqual(sealed);
    taken.dispose();
  });

  it("a home that took the copy's values but stopped before sealing again seals them at its next start", async () => {
    const mini = computer("mini");
    const laptop = computer("laptop");
    const oldHome = home(disposableCustody());
    const userData = scratchDir("standby-secrets-record-");
    await oldHome.put(TOKEN);
    const standbys = standbySecrets(userData, oldHome.settings, [mini, laptop]);
    await standbys.keep("mini");
    await kept(standbys, "mini");
    await standbys.keep("laptop");
    await kept(standbys, "laptop");
    standbys.dispose();

    const record = copyRecord(userData);
    const sealed = readSealedSecrets(record);
    const locks = readStandbyLocks(record);
    const newHome = home(mini.secretsCustody);
    const first = standbySecrets(record, newHome.settings, [laptop], mini.lockCustody);
    await first.adopt();
    first.dispose();
    // The app stopped before its sealing reached the file: the record still names the old home.
    writeSealedSecrets(record, sealed ?? null);
    writeStandbyLocks(record, locks);

    const next = standbySecrets(record, newHome.settings, [laptop], mini.lockCustody);
    await next.adopt();
    // It does not take them again, and seals its own for the laptop alone.
    const now = readSealedSecrets(record);
    expect(now?.source).not.toBe(sealed?.source);
    expect(now?.keys.map((each) => each.device)).toEqual(["laptop"]);
    await newHome.use("after-restart");
    expect(newHome.sent).toEqual([`Bearer ${TOKEN}`]);
    next.dispose();
  });

  it("a home that took one sealed file never takes a later one from the same home as already its own", async () => {
    const mini = computer("mini");
    const laptop = computer("laptop");
    const miniHome = home(mini.secretsCustody);
    const miniRecord = scratchDir("standby-secrets-record-");
    await miniHome.put(TOKEN);
    const sealing = standbySecrets(miniRecord, miniHome.settings, [laptop]);
    await sealing.keep("laptop");
    await kept(sealing, "laptop");

    const laptopRecord = copyRecord(miniRecord);
    const laptopHome = home(laptop.secretsCustody);
    const first = standbySecrets(laptopRecord, laptopHome.settings, [], laptop.lockCustody);
    await first.adopt();
    first.dispose();

    // The first mate moves back to the mini, whose own Secrets stayed there, and it
    // seals newer values to the laptop, which the laptop's copy takes as it stands.
    await miniHome.put(CHANGED);
    await sealing.seal();
    const newer = readSealedSecrets(miniRecord);
    sealing.dispose();
    for (const file of [SEALED_SECRETS_FILE, STANDBY_LOCKS_FILE])
      cpSync(join(miniRecord, file), join(laptopRecord, file));

    // The laptop takes over again: the newer file is not one it took, so it seals nothing over it.
    const again = standbySecrets(laptopRecord, laptopHome.settings, [], laptop.lockCustody);
    await again.adopt();
    await again.seal();
    expect(readSealedSecrets(laptopRecord)).toEqual(newer);
    again.dispose();
  });

  it("a computer whose lock is listed reads kept only once the values are sealed to it", async () => {
    const mini = computer("mini");
    const oldHome = home(disposableCustody());
    const userData = scratchDir("standby-secrets-record-");
    await oldHome.put(TOKEN);
    const standbys = new StandbySecrets({
      userData,
      secrets: {
        sealedState: () => oldHome.settings.sealedState(),
        sealForStandbys: async () => "unavailable",
        adoptStandby: (files) => oldHome.settings.adoptStandby(files),
        offer: (...args) => oldHome.settings.offer(...args),
      },
      ownLock: undefined,
      speaks: () => true,
      ask: (_deviceId, _channel, args) => mini.keeper.answer(args),
      listed: () => ["mini"],
      changed: () => {},
      log: () => {},
      pollMs: 5,
    });
    await standbys.keep("mini");
    while (standbys.state("mini") === "asking") await new Promise((done) => setTimeout(done, 5));
    expect(readStandbyLocks(userData).locks.map((each) => each.device)).toEqual(["mini"]);
    expect(standbys.state("mini")).toBe("none");
    standbys.dispose();
  });
});
