import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type PhonePushLetter, phonePushLetterSchema } from "@shared/phonePush";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { PairingPushRecords } from "./devices/pairingPushRecords";
import {
  LETTER_READ_EVERY_MS,
  letterBox,
  openLetter,
  PhoneLetters,
  sealLetter,
} from "./phoneLetters";

/**
 * Letters on the computer (docs/phone-push.md, "Letters"; INF-5275's plan,
 * piece 2, the captain's Approve and build): each phone's box is read once a
 * day and right after the relay refuses its grant, and only a newer letter
 * changes where its cards go. The records are the real `PairingPushRecords`
 * over a scratch folder; the relay is a stand-in that keeps letters by box,
 * as the relay's letter requests do.
 */

/** Letters the phone's own code sealed (`PhonePush.sealLetter`), which the computer opens. */
const FIXTURE = phonePushLettersFixture();

function phonePushLettersFixture() {
  const path = fileURLToPath(
    new URL(
      "../../ios/Infinitary/InfinitaryKit/Tests/InfinitaryKitTests/Fixtures/PhonePushLetters.json",
      import.meta.url,
    ),
  );
  return JSON.parse(readFileSync(path, "utf8")) as {
    key: string;
    box: string;
    otherKey: string;
    otherBox: string;
    renew: { sealed: string; opens: unknown };
    stop: { sealed: string; opens: unknown };
    otherKeyRenew: { sealed: string };
  };
}

const PHONE = "phone-1";
const DAY = 86_400_000;
// The relay's grants: an expiry in seconds, a dot and a signature.
const grantUntil = (seconds: number) => `${seconds}.${randomBytes(32).toString("base64url")}`;

function registration(key = randomBytes(32).toString("base64url")) {
  return {
    token: randomBytes(32).toString("hex"),
    environment: "production" as const,
    grant: grantUntil(1_797_000_000),
    key,
  };
}

/** A relay stand-in: letter reads answer from `boxes`, or `status` when set. */
function relayStandIn() {
  const boxes = new Map<string, string>();
  const reads: { url: string; box: string; redirect: RequestRedirect | undefined }[] = [];
  const state: { status?: number } = {};
  const fetchStandIn = (async (url: string | URL | Request, init?: RequestInit) => {
    const { box } = JSON.parse(String(init?.body));
    reads.push({ url: String(url), box, redirect: init?.redirect });
    if (state.status !== undefined) return new Response(null, { status: state.status });
    const sealed = boxes.get(box);
    return sealed
      ? new Response(JSON.stringify({ sealed }), { status: 200 })
      : new Response(null, { status: 204 });
  }) as typeof fetch;
  return { boxes, reads, state, fetch: fetchStandIn };
}

function setup(dir = scratchDir("infinitary-phone-letters-")) {
  mkdirSync(dir, { recursive: true });
  const clock = { now: 1_795_000_000_000 };
  const problems: string[] = [];
  const records = new PairingPushRecords(
    dir,
    () => clock.now,
    (file, value) => writeFileSync(join(dir, file), JSON.stringify(value)),
    (text) => problems.push(text),
  );
  records.load();
  const entries = [{ id: PHONE }];
  const relay = relayStandIn();
  const letters = new PhoneLetters({
    phones: {
      letterBoxes: () => records.letterBoxes(entries),
      noteLetterRead: (deviceId, at) => records.noteLetterRead(deviceId, at),
      takeLetter: (deviceId, key, letter) => records.takeLetter(deviceId, key, letter),
    },
    relay: "https://relay.test/v1/push",
    fetch: relay.fetch,
    now: () => clock.now,
    onProblem: (text) => problems.push(text),
  });
  const targets = () => records.targets(entries);
  const file = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
  return { dir, clock, problems, records, relay, letters, targets, file };
}

const renew = (token: string, grant: string, at: number): PhonePushLetter => ({
  v: 1,
  kind: "renew",
  token,
  environment: "production",
  grant,
  at,
});

describe("letters the phone seals", () => {
  it("opens what the phone's own code sealed, in the box the phone named, and nothing under another key", () => {
    expect(letterBox(FIXTURE.key)).toBe(FIXTURE.box);
    expect(letterBox(FIXTURE.otherKey)).toBe(FIXTURE.otherBox);
    expect(FIXTURE.box).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(openLetter(FIXTURE.key, FIXTURE.renew.sealed)).toEqual(
      phonePushLetterSchema.parse(FIXTURE.renew.opens),
    );
    expect(openLetter(FIXTURE.key, FIXTURE.stop.sealed)).toEqual(
      phonePushLetterSchema.parse(FIXTURE.stop.opens),
    );
    expect(openLetter(FIXTURE.key, FIXTURE.otherKeyRenew.sealed)).toBeNull();
    expect(openLetter(FIXTURE.otherKey, FIXTURE.otherKeyRenew.sealed)).toEqual(
      phonePushLetterSchema.parse(FIXTURE.renew.opens),
    );
    expect(openLetter(FIXTURE.key, FIXTURE.renew.sealed.slice(0, -8))).toBeNull();
  });
});

describe("PhoneLetters", () => {
  it("reads each phone's box at most once a day, and once more right after a refusal", async () => {
    const { clock, records, relay, letters } = setup();
    const phone = registration();
    records.set(PHONE, phone);
    await letters.readDue();
    expect(relay.reads).toEqual([
      { url: "https://relay.test/v1/letter/read", box: letterBox(phone.key), redirect: "error" },
    ]);
    clock.now += DAY - 1;
    await letters.readDue();
    expect(relay.reads).toHaveLength(1);
    // A refusal reads it once more whenever it was last read.
    expect(await letters.readNow(PHONE)).toBe(false);
    expect(relay.reads).toHaveLength(2);
    clock.now += LETTER_READ_EVERY_MS;
    await letters.readDue();
    expect(relay.reads).toHaveLength(3);
    // The box reads only the phone's box name, never its key or address.
    for (const read of relay.reads) expect(read.box).not.toBe(phone.key);
  });

  it("takes a renew letter only when newer, replacing the address and grant and keeping the key", async () => {
    const { clock, records, relay, letters, targets, file } = setup();
    const phone = registration();
    records.set(PHONE, { ...phone, withdrawals: true });
    const box = letterBox(phone.key);
    const token = randomBytes(32).toString("hex");
    const later = grantUntil(1_797_500_000);
    relay.boxes.set(box, sealLetter(phone.key, renew(token, later, clock.now)));
    await letters.readDue();
    expect(targets()).toEqual([
      {
        deviceId: PHONE,
        registration: {
          token,
          environment: "production",
          grant: later,
          key: phone.key,
          withdrawals: true,
        },
      },
    ]);
    // pushes.json keeps the shape an older app reads; the letter's time is in its own file.
    expect(Object.keys(file("pushes.json").devices[PHONE]).sort()).toEqual([
      "at",
      "environment",
      "grant",
      "key",
      "token",
    ]);
    expect(file("push-letters.json").devices[PHONE]).toEqual({ read: clock.now, at: clock.now });

    // The same letter again, an older one with a later grant, and a newer one
    // whose grant expires no later than the one kept change nothing.
    const replayed = [
      sealLetter(phone.key, renew(token, later, clock.now)),
      sealLetter(phone.key, renew(token, grantUntil(1_797_900_000), clock.now - 1)),
      sealLetter(phone.key, renew(token, grantUntil(1_797_400_000), clock.now + 1)),
      // Sealed under another key: it does not open.
      sealLetter(
        randomBytes(32).toString("base64url"),
        renew(token, grantUntil(1_798_000_000), clock.now + 2),
      ),
    ];
    for (const sealed of replayed) {
      relay.boxes.set(box, sealed);
      clock.now += DAY;
      await letters.readDue();
      expect(targets()[0]?.registration.grant).toBe(later);
    }
  });

  it("forgets the registration and the key on a stop letter", async () => {
    const { clock, records, relay, letters, targets, file } = setup();
    records.set(PHONE, { ...registration(FIXTURE.key), withdrawals: true });
    relay.boxes.set(FIXTURE.box, FIXTURE.stop.sealed);
    clock.now = 1_795_000_100_000;
    await letters.readDue();
    expect(targets()).toEqual([]);
    expect(file("pushes.json").devices).toEqual({});
    expect(file("push-withdrawals.json").devices).toEqual({});
    expect(records.letterBoxes([{ id: PHONE }])).toEqual([]);
    expect(file("push-letters.json").devices[PHONE]).toEqual({ at: 1_795_000_060_456 });
  });

  it("keeps the key after a refusal with no newer letter, reads daily, and forgets it 30 days after the grant lapsed", async () => {
    const { clock, records, relay, letters, targets, file } = setup();
    const phone = { ...registration(), withdrawals: true as const };
    records.set(PHONE, phone);
    records.forget(PHONE, phone.grant);
    expect(targets()).toEqual([]);
    expect(file("pushes.json").devices).toEqual({});
    expect(file("push-letters.json").devices[PHONE]).toEqual({
      key: phone.key,
      grant: phone.grant,
      withdrawals: true,
    });
    expect(await letters.readNow(PHONE)).toBe(false);
    expect(relay.reads.map((read) => read.box)).toEqual([letterBox(phone.key)]);

    // The phone's newer grant arrives by letter a day later: the record comes
    // back with the key kept and whether it takes withdrawals.
    const token = randomBytes(32).toString("hex");
    const later = grantUntil(1_797_300_000);
    relay.boxes.set(letterBox(phone.key), sealLetter(phone.key, renew(token, later, clock.now)));
    clock.now += DAY;
    await letters.readDue();
    expect(targets()[0]?.registration).toEqual({ ...phone, token, grant: later });

    // Refused again with nothing newer: the key is read until 30 days after
    // that grant would have expired, then forgotten.
    records.forget(PHONE, later);
    clock.now = 1_797_300_000_000 + 30 * DAY;
    expect(records.letterBoxes([{ id: PHONE }])).toHaveLength(1);
    clock.now += 1;
    expect(records.letterBoxes([{ id: PHONE }])).toEqual([]);
    expect(file("push-letters.json").devices[PHONE]?.key).toBeUndefined();
  });

  it("drops the kept key once the phone hands a registration or null, and starts a new key's box afresh", async () => {
    const { records, file } = setup();
    const phone = registration();
    records.set(PHONE, phone);
    records.noteLetterRead(PHONE, 1);
    records.forget(PHONE, phone.grant);
    // The refused grant handed again is still not kept, and the key stays.
    expect(records.set(PHONE, phone)).toEqual({ kept: false });
    expect(file("push-letters.json").devices[PHONE].key).toBe(phone.key);
    const next = { ...registration(), grant: grantUntil(1_797_100_000) };
    expect(records.set(PHONE, next)).toEqual({ kept: true });
    expect(file("push-letters.json").devices[PHONE]).toBeUndefined();
    expect(records.letterBoxes([{ id: PHONE }])).toEqual([{ deviceId: PHONE, key: next.key }]);
    records.set(PHONE, null);
    expect(records.letterBoxes([{ id: PHONE }])).toEqual([]);
  });

  it("takes a relay without letters or an empty box as no letter, and tries a failed read at the next pass", async () => {
    const { clock, records, relay, letters, targets, problems } = setup();
    const phone = registration();
    records.set(PHONE, phone);
    relay.state.status = 404;
    await letters.readDue();
    clock.now += DAY - 1;
    await letters.readDue();
    expect(relay.reads).toHaveLength(1);
    relay.state.status = 503;
    clock.now += 1;
    await letters.readDue();
    await letters.readDue();
    expect(relay.reads).toHaveLength(3);
    expect(problems).toEqual([
      "the push relay refused a letter read with 503",
      "the push relay refused a letter read with 503",
    ]);
    expect(targets()[0]?.registration).toEqual(phone);
  });

  it("reads no box and never writes over a letter file it cannot read", async () => {
    const dir = scratchDir("infinitary-phone-letters-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "push-letters.json"), "{ not json");
    const { records, relay, letters, problems } = setup(dir);
    const phone = registration();
    records.set(PHONE, phone);
    await letters.readDue();
    records.forget(PHONE, phone.grant);
    expect(relay.reads).toEqual([]);
    expect(readFileSync(join(dir, "push-letters.json"), "utf8")).toBe("{ not json");
    expect(problems).toEqual([
      "What each phone's letters left cannot be read; no letter is read until it is moved away.",
    ]);
    expect(existsSync(join(dir, "pushes.json"))).toBe(true);
  });
});
