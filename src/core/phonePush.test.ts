import { createDecipheriv, randomBytes } from "node:crypto";
import type { Card } from "@shared/cards";
import {
  type PhonePushRegistration,
  phonePushCardSchema,
  phonePushRelayRequestSchema,
  phonePushWithdrawalSchema,
} from "@shared/phonePush";
import { describe, expect, it } from "vitest";
import { NOTICE_BODY_LIMIT } from "./notifications";
import { APPLE_PAYLOAD_LIMIT, PhonePushes, WITHDRAW_SPACING_MS } from "./phonePush";

/**
 * The phone sender on its own (docs/phone-push.md; INF-4774's plan, approved
 * by the captain: title and first line, sealed so only the phone reads it).
 * The relay is a stand-in that keeps what it was posted; the phone's side is
 * opened here as the page says a phone opens it, not with the sender's code.
 */

const PHONE = "phone-1";

function registration() {
  return {
    token: "5f3c8e1a9b2d4c6e8f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e",
    environment: "production" as const,
    grant: `1797811200.${randomBytes(32).toString("base64url")}`,
    key: randomBytes(32).toString("base64url"),
  };
}

/** What the phone does with a push: AES-256-GCM open of nonce, ciphertext, tag. */
function openAsThePhone(key: string, sealed: string) {
  return phonePushCardSchema.parse(openText(key, sealed));
}

/** What the phone does with a withdrawal: the same open, then the withdrawal's shape. */
function withdrawalAsThePhone(key: string, sealed: string) {
  return phonePushWithdrawalSchema.parse(openText(key, sealed));
}

function openText(key: string, sealed: string): unknown {
  const bytes = Buffer.from(sealed, "base64url");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64url"),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  const text = Buffer.concat([
    decipher.update(bytes.subarray(12, bytes.length - 16)),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(text);
}

/** The relay answers 204 when Apple accepted a push (its contract, "Answers"). */
function relayStandIn(status = 204) {
  const answer = { status };
  const posts: { url: string; body: string; redirect: RequestRedirect | undefined }[] = [];
  const fetchStandIn = (async (url: string | URL | Request, init?: RequestInit) => {
    posts.push({ url: String(url), body: String(init?.body), redirect: init?.redirect });
    return new Response(null, { status: answer.status });
  }) as typeof fetch;
  return { posts, fetch: fetchStandIn, answer };
}

const NOTICE = {
  kind: "card" as const,
  cardId: "card-launch-week",
  title: "Plan the launch week",
  body: "Three dates fit; pick one.",
};

describe("PhonePushes", () => {
  it("posts each phone only its grant, its push address and the card sealed under its own key", async () => {
    const phone = registration();
    const tablet = registration();
    const relay = relayStandIn();
    const forgotten: string[] = [];
    const pushes = new PhonePushes({
      targets: () => [
        { deviceId: PHONE, registration: phone },
        { deviceId: "tablet", registration: tablet },
      ],
      forget: (deviceId) => forgotten.push(deviceId),
      relay: "https://relay.test/v1/push",
      fetch: relay.fetch,
      onProblem: (text) => {
        throw new Error(text);
      },
    });
    expect(pushes.any()).toBe(true);
    pushes.send(NOTICE);
    await pushes.settled();

    expect(relay.posts).toHaveLength(2);
    const [toPhone, toTablet] = relay.posts.map((post) => ({
      ...post,
      request: phonePushRelayRequestSchema.parse(JSON.parse(post.body)),
    }));
    expect(toPhone?.url).toBe("https://relay.test/v1/push");
    expect(toPhone?.redirect).toBe("error");
    expect(toPhone?.request).toMatchObject({
      token: phone.token,
      environment: "production",
      grant: phone.grant,
    });
    expect(toTablet?.request).toMatchObject({ grant: tablet.grant, token: tablet.token });
    // The relay reads none of the card's words, and no key.
    for (const post of relay.posts) {
      for (const word of ["Plan", "launch", "Three dates", "card-launch-week", phone.key])
        expect(post.body).not.toContain(word);
    }
    // Each phone opens its own, and only its own.
    // Each names this push, which a withdrawal names in turn.
    const push = expect.any(String);
    expect(openAsThePhone(phone.key, toPhone?.request.sealed ?? "")).toEqual({
      v: 1,
      ...NOTICE,
      push,
    });
    expect(openAsThePhone(tablet.key, toTablet?.request.sealed ?? "")).toEqual({
      v: 1,
      ...NOTICE,
      push,
    });
    expect(() => openAsThePhone(tablet.key, toPhone?.request.sealed ?? "")).toThrow();
    expect(forgotten).toEqual([]);
  });

  it("cuts a long title so a push stays inside Apple's payload, and keeps a reply a reply", async () => {
    const phone = registration();
    const relay = relayStandIn();
    const pushes = new PhonePushes({
      targets: () => [{ deviceId: PHONE, registration: phone }],
      forget: () => {},
      relay: "https://relay.test/v1/push",
      fetch: relay.fetch,
      onProblem: () => {},
    });
    const title = "Which of the three venues should hold the launch week? ".repeat(10);
    pushes.send({ ...NOTICE, kind: "reply", title, body: "x".repeat(140) });
    // The largest notice: every unit of the title and of the longest body a
    // three-byte character, the most UTF-8 a code unit takes once control
    // characters are gone, and a long card id.
    const wide = "界";
    pushes.send({
      kind: "card",
      cardId: `card-${"a".repeat(123)}`,
      title: wide.repeat(400),
      body: wide.repeat(NOTICE_BODY_LIMIT),
    });
    await pushes.settled();
    const { sealed } = phonePushRelayRequestSchema.parse(JSON.parse(relay.posts[0]?.body ?? ""));
    const opened = openAsThePhone(phone.key, sealed);
    expect(opened.kind).toBe("reply");
    expect(title.startsWith(opened.title)).toBe(true);
    expect(opened.title.length).toBeLessThan(title.length);
    // Apple takes 4 KB for the whole payload, which the relay builds around
    // the sealed text with its fallback words (its worker's push route).
    const largest = phonePushRelayRequestSchema.parse(JSON.parse(relay.posts[1]?.body ?? ""));
    expect(openAsThePhone(phone.key, largest.sealed).body).toBe(wide.repeat(NOTICE_BODY_LIMIT));
    const apple = JSON.stringify({
      aps: { alert: { body: "A card is ready" }, sound: "default", "mutable-content": 1 },
      sealed: largest.sealed,
    });
    expect(Buffer.byteLength(apple)).toBeLessThanOrEqual(4096);
  });

  it.each([
    [410, "Apple no longer takes the push address"],
    [403, "the grant expired or does not name the address"],
  ])(
    "forgets a registration the relay answers %i for (%s), and sends nothing with no phone",
    async (status) => {
      const phone = registration();
      const relay = relayStandIn(status);
      const forgotten: { deviceId: string; grant: string }[] = [];
      let targets = [{ deviceId: PHONE, registration: phone }];
      const pushes = new PhonePushes({
        targets: () => targets,
        forget: (deviceId, grant) => {
          forgotten.push({ deviceId, grant });
          targets = [];
        },
        relay: "https://relay.test/v1/push",
        fetch: relay.fetch,
        onProblem: () => {},
      });
      pushes.send(NOTICE);
      await pushes.settled();
      expect(forgotten).toEqual([{ deviceId: PHONE, grant: phone.grant }]);
      expect(pushes.any()).toBe(false);
      pushes.send(NOTICE);
      await pushes.settled();
      expect(relay.posts).toHaveLength(1);
    },
  );

  // INF-5275's plan, piece 2: a computer the phone is not showing learns a
  // renewed grant from the letter the phone left; the refused card goes once
  // more under it, and only once.
  it.each([403, 410])(
    "sends a card refused with %i once more after a newer letter, under the renewed registration",
    async (status) => {
      const old = registration();
      const renewed = { ...registration(), key: old.key };
      let targets = [{ deviceId: PHONE, registration: old }];
      const posts: { grant: string; sealed: string }[] = [];
      const refusedGrants = new Set([old.grant]);
      const read: string[] = [];
      let letterRenews = true;
      const pushes = new PhonePushes({
        targets: () => targets,
        forget: () => {
          targets = [];
        },
        refused: async (deviceId) => {
          read.push(deviceId);
          if (letterRenews) targets = [{ deviceId: PHONE, registration: renewed }];
          return letterRenews;
        },
        relay: "https://relay.test/v1/push",
        fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
          const request = phonePushRelayRequestSchema.parse(JSON.parse(String(init?.body)));
          posts.push(request);
          return new Response(null, { status: refusedGrants.has(request.grant) ? status : 204 });
        }) as typeof fetch,
        onProblem: () => {},
      });
      pushes.send(NOTICE);
      await pushes.settled();
      expect(read).toEqual([PHONE]);
      expect(posts.map((post) => post.grant)).toEqual([old.grant, renewed.grant]);
      const [first, again] = posts.map((post) => openAsThePhone(old.key, post.sealed));
      expect(again).toEqual(first);

      // The card sent once more is refused too: it is not sent a third time.
      targets = [{ deviceId: PHONE, registration: old }];
      refusedGrants.add(renewed.grant);
      pushes.send(NOTICE);
      await pushes.settled();
      expect(posts.slice(2).map((post) => post.grant)).toEqual([old.grant, renewed.grant]);
      expect(read).toEqual([PHONE, PHONE, PHONE]);

      // With no newer letter, nothing goes again.
      letterRenews = false;
      targets = [{ deviceId: PHONE, registration: old }];
      pushes.send(NOTICE);
      await pushes.settled();
      expect(posts).toHaveLength(5);
    },
  );

  it("says a refused or unreachable relay in one line with no card words", async () => {
    const problems: string[] = [];
    const refusing = new PhonePushes({
      targets: () => [{ deviceId: PHONE, registration: registration() }],
      forget: () => {},
      relay: "https://relay.test/v1/push",
      fetch: relayStandIn(502).fetch,
      onProblem: (text) => problems.push(text),
    });
    refusing.send(NOTICE);
    await refusing.settled();
    const unreachable = new PhonePushes({
      targets: () => [{ deviceId: PHONE, registration: registration() }],
      forget: () => {},
      relay: "https://relay.test/v1/push",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      onProblem: (text) => problems.push(text),
    });
    unreachable.send(NOTICE);
    await unreachable.settled();
    expect(problems).toEqual([
      "the push relay refused a card push with 502",
      "a card push did not reach the relay: TypeError",
    ]);
  });

  it("waits a minute after a 429 for that phone, and after a 503 for every phone", async () => {
    const phone = registration();
    const tablet = registration();
    const relay = relayStandIn(429);
    let now = 1_000_000;
    const problems: string[] = [];
    const pushes = new PhonePushes({
      targets: () => [
        { deviceId: PHONE, registration: phone },
        { deviceId: "tablet", registration: tablet },
      ],
      forget: () => {
        throw new Error("a wait forgets nothing");
      },
      relay: "https://relay.test/v1/push",
      fetch: relay.fetch,
      now: () => now,
      onProblem: (text) => problems.push(text),
    });
    const tokensPosted = () =>
      relay.posts.map((post) => phonePushRelayRequestSchema.parse(JSON.parse(post.body)).token);

    // Both phones are over the limit; within the minute neither is posted.
    pushes.send(NOTICE);
    await pushes.settled();
    expect(relay.posts).toHaveLength(2);
    now += 59_000;
    pushes.send(NOTICE);
    await pushes.settled();
    expect(relay.posts).toHaveLength(2);

    // After the minute both are posted again; the relay itself is not ready.
    now += 1_000;
    relay.answer.status = 503;
    pushes.send(NOTICE);
    await pushes.settled();
    expect(tokensPosted().slice(2)).toEqual([phone.token, tablet.token]);
    now += 59_000;
    pushes.send(NOTICE);
    await pushes.settled();
    expect(relay.posts).toHaveLength(4);

    // Once the relay's minute is over, every phone hears the next card.
    now += 1_000;
    relay.answer.status = 204;
    pushes.send(NOTICE);
    await pushes.settled();
    expect(tokensPosted().slice(4)).toEqual([phone.token, tablet.token]);
    expect(problems).toEqual([
      "the push relay refused a card push with 429",
      "the push relay refused a card push with 429",
      "the push relay refused a card push with 503",
      "the push relay refused a card push with 503",
    ]);
  });
});

/** A card on the stage as the cards broadcast carries it. */
function stageCard(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    author: "crewmate",
    priority: 15,
    title: "Fix the footer links",
    meta: "crewmate",
    body: "The footer links open the old docs.",
    actions: [],
    status: "ready",
    createdAt: 1_000_000,
    currentUpdateSeen: false,
    ...overrides,
  };
}

/**
 * A sender with a phone that takes withdrawals and a tablet that does not
 * (or does, with `tabletWithdraws`), a clock the test moves, and the waits it
 * would set kept for the test to run (docs/phone-push.md, "Withdrawals").
 * `answerFor` answers one request by its address and push address, and
 * `holdNextPush` keeps the relay's answer to the next card push until the
 * test releases it.
 */
function withdrawing(status = 204, options: { tabletWithdraws?: boolean } = {}) {
  let phone: PhonePushRegistration = { ...registration(), withdrawals: true as const };
  const tablet: PhonePushRegistration = {
    ...registration(),
    token: "a".repeat(64),
    ...(options.tabletWithdraws ? { withdrawals: true as const } : {}),
  };
  const relay = relayStandIn(status);
  const clock = { now: 5_000_000, on: true };
  const waits: { at: number; run: () => void }[] = [];
  const problems: string[] = [];
  const forgotten: string[] = [];
  /** When each withdrawal reached the relay. */
  const sentAt: number[] = [];
  /** Each request the relay received: where, to which push address, and when. */
  const sent: { url: string; token: string; at: number }[] = [];
  const answers: { answerFor?: (url: string, token: string) => number | undefined } = {};
  let held: Promise<void> | undefined;
  const fetchAndTime = (async (url: string | URL | Request, init?: RequestInit) => {
    const { token } = phonePushRelayRequestSchema.parse(JSON.parse(String(init?.body)));
    if (String(url).endsWith("/v1/withdraw")) sentAt.push(clock.now);
    sent.push({ url: String(url), token, at: clock.now });
    const hold = String(url).endsWith("/v1/push") ? held : undefined;
    if (hold) {
      held = undefined;
      await hold;
    }
    const answer = answers.answerFor?.(String(url), token);
    if (answer === undefined) return relay.fetch(url, init);
    relay.posts.push({ url: String(url), body: String(init?.body), redirect: init?.redirect });
    return new Response(null, { status: answer });
  }) as typeof fetch;
  let targets = () => [
    { deviceId: PHONE, registration: phone },
    { deviceId: "tablet", registration: tablet },
  ];
  const pushes = new PhonePushes({
    targets: () => targets(),
    forget: (deviceId) => {
      forgotten.push(deviceId);
      targets = () => [];
    },
    relay: "https://relay.test/v1/push",
    switchedOn: () => clock.on,
    fetch: fetchAndTime,
    now: () => clock.now,
    later: (run, ms) => waits.push({ at: clock.now + ms, run }),
    onProblem: (text) => problems.push(text),
  });
  /** Pushes each card to both phones. */
  const push = async (...ids: string[]) => {
    for (const id of ids) pushes.send({ ...NOTICE, cardId: id });
    await pushes.settled();
  };
  /** The withdrawals the relay received for one phone, opened as that phone opens them. */
  const withdrawalsTo = (to: PhonePushRegistration) =>
    relay.posts
      .filter((post) => post.url === "https://relay.test/v1/withdraw")
      .map((post) => phonePushRelayRequestSchema.parse(JSON.parse(post.body)))
      .filter((request) => request.token === to.token)
      .map((request) => {
        expect(request.grant).toBe(to.grant);
        return withdrawalAsThePhone(to.key, request.sealed);
      });
  const withdrawals = () =>
    withdrawalsTo(phone).map((withdrawal) => withdrawal.cards.map((card) => card.cardId));
  /** Each withdrawal's cards and pushes, as the phone opens them. */
  const cards = () => withdrawalsTo(phone).map((withdrawal) => withdrawal.cards);
  /** The name of each card push the phone was sent, in the order sent. */
  const pushNames = () =>
    relay.posts
      .filter((post) => post.url === "https://relay.test/v1/push")
      .map((post) => phonePushRelayRequestSchema.parse(JSON.parse(post.body)))
      .filter((request) => request.token === phone.token)
      .map((request) => openAsThePhone(phone.key, request.sealed).push);
  /** Keeps the relay's answer to the next card push until `release` runs. */
  const holdNextPush = () => {
    let release = () => {};
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => release();
  };
  /** The phone hands its registration again, with the same push address and key. */
  const handAgain = () => {
    phone = { ...phone };
  };
  /** The phone hands a new registration: a new push address and key. */
  const handAnew = () => {
    phone = { ...registration(), token: "b".repeat(64), withdrawals: true as const };
    return phone;
  };
  /** Moves the clock and runs every wait that came due. */
  const pass = async (ms: number) => {
    clock.now += ms;
    const due = waits.filter((entry) => entry.at <= clock.now);
    waits.splice(0, waits.length, ...waits.filter((entry) => entry.at > clock.now));
    for (const wait of due) wait.run();
    await pushes.settled();
  };
  return {
    pushes,
    relay,
    get phone() {
      return phone;
    },
    tablet,
    clock,
    sent,
    answers,
    withdrawalsTo,
    cards,
    pushNames,
    holdNextPush,
    handAgain,
    handAnew,
    waits,
    problems,
    forgotten,
    sentAt,
    push,
    withdrawals,
    pass,
  };
}

describe("PhonePushes withdrawals", () => {
  const FOOTER = "card-3f2a9c1e-merge-footer-fix";
  const LOGIN = "card-8b41d07a-login-timeout";
  const VENUE = "card-c5e92f13-launch-venue";
  const DOCS = "card-07d3aa58-docs-site-plan";

  it("withdraws a pushed card once seen, sealed for the phone that takes withdrawals alone", async () => {
    const w = withdrawing();
    await w.push(FOOTER, LOGIN);
    w.pushes.observe([stageCard(FOOTER), stageCard(LOGIN)]);
    await w.pushes.settled();
    expect(w.withdrawals()).toEqual([]);

    w.pushes.observe([stageCard(FOOTER, { currentUpdateSeen: true }), stageCard(LOGIN)]);
    await w.pushes.settled();
    // Only the phone that set the flag hears it, at once, naming only the seen card.
    expect(w.withdrawals()).toEqual([[FOOTER]]);
    const withdrawPosts = w.relay.posts.filter((post) => post.url.endsWith("/v1/withdraw"));
    expect(withdrawPosts).toHaveLength(1);
    expect(withdrawPosts[0]?.redirect).toBe("error");
    // The relay reads no card id, no key.
    for (const word of [FOOTER, LOGIN, w.phone.key])
      expect(withdrawPosts[0]?.body).not.toContain(word);
    expect(w.problems).toEqual([]);
  });

  it("withdraws answered, ended and gone cards too, newest first, and never an unseen one", async () => {
    const w = withdrawing();
    await w.push(FOOTER, LOGIN, VENUE, DOCS);
    w.pushes.observe([FOOTER, LOGIN, VENUE, DOCS].map((id) => stageCard(id)));
    // The captain replied under one: it waits on its author, off the stage.
    w.pushes.observe([
      stageCard(FOOTER, { awaiting: "answer" }),
      stageCard(LOGIN),
      stageCard(VENUE),
      stageCard(DOCS),
    ]);
    await w.pushes.settled();
    expect(w.withdrawals()).toEqual([[FOOTER]]);

    // Within the spacing, an ended card and a gone card wait their turn.
    w.pushes.observe([
      stageCard(LOGIN, {
        ended: { by: "crewmate", at: 5_000_100, line: "The crewmate ended this card." },
      }),
      stageCard(DOCS),
    ]);
    await w.pushes.settled();
    expect(w.withdrawals()).toHaveLength(1);
    await w.pass(WITHDRAW_SPACING_MS - 1);
    expect(w.withdrawals()).toHaveLength(1);
    await w.pass(1);
    // One withdrawal names every card withdrawn so far, newest first.
    const [, second] = w.withdrawals();
    expect(second?.slice(2)).toEqual([FOOTER]);
    expect(new Set(second?.slice(0, 2))).toEqual(new Set([LOGIN, VENUE]));
    expect(second).not.toContain(DOCS);
  });

  it("sends at most three an hour, and none while the switch is off", async () => {
    const w = withdrawing();
    const ids = Array.from({ length: 8 }, (_, at) => `card-${at}0a1b2c3-review-${at}`);
    await w.push(...ids);
    w.pushes.observe(ids.map((id) => stageCard(id)));
    // A card is seen every five minutes for an hour.
    for (const [at] of ids.entries()) {
      w.pushes.observe(ids.map((id, index) => stageCard(id, { currentUpdateSeen: index <= at })));
      await w.pass(5 * 60_000);
    }
    await w.pass(WITHDRAW_SPACING_MS);
    // The first went at once, each later one a spacing after the one before,
    // so no hour holds more than three; the last names every seen card.
    expect(w.sentAt).toEqual([0, 1, 2].map((at) => (w.sentAt[0] ?? 0) + at * WITHDRAW_SPACING_MS));
    for (const at of w.sentAt)
      expect(
        w.sentAt.filter((other) => other >= at && other < at + 60 * 60_000).length,
      ).toBeLessThanOrEqual(3);
    expect(new Set(w.withdrawals().at(-1))).toEqual(new Set(ids));

    const quiet = withdrawing();
    await quiet.push(FOOTER);
    quiet.clock.on = false;
    quiet.pushes.observe([stageCard(FOOTER, { currentUpdateSeen: true })]);
    await quiet.pass(WITHDRAW_SPACING_MS);
    expect(quiet.withdrawals()).toEqual([]);
    // Turned on again, the withdrawal held while it was off goes, with no new broadcast.
    quiet.clock.on = true;
    quiet.pushes.switched();
    await quiet.pushes.settled();
    expect(quiet.withdrawals()).toEqual([[FOOTER]]);
  });

  it("withdraws a card seen before the relay took its push, only while the phone keeps that registration", async () => {
    const w = withdrawing();
    // The captain sees the card on the computer before the relay answers its push.
    const release = w.holdNextPush();
    w.pushes.send({ ...NOTICE, cardId: FOOTER });
    w.pushes.observe([stageCard(FOOTER, { currentUpdateSeen: true })]);
    release();
    await w.pushes.settled();
    expect(w.withdrawals()).toEqual([[FOOTER]]);

    // The phone hands a new registration while a push to its old one is in flight:
    // that push's answer adds nothing to the new registration's list.
    const releaseLogin = w.holdNextPush();
    w.pushes.send({ ...NOTICE, cardId: LOGIN });
    const anew = w.handAnew();
    w.pushes.observe([stageCard(LOGIN, { currentUpdateSeen: true })]);
    releaseLogin();
    await w.pass(WITHDRAW_SPACING_MS);
    expect(w.withdrawalsTo(anew)).toEqual([]);
  });

  it("keeps a card's newer push off the list, and the list across a hand-over to the same address and key", async () => {
    const w = withdrawing();
    await w.push(FOOTER, LOGIN);
    w.pushes.observe([stageCard(FOOTER, { currentUpdateSeen: true }), stageCard(LOGIN)]);
    await w.pushes.settled();
    const [footerFirst, login] = w.pushNames();
    expect(w.cards()).toEqual([[{ cardId: FOOTER, pushes: [footerFirst] }]]);

    // Its author answered the captain's reply: the broadcast shows it unseen,
    // and it is pushed again; the list names only its first push, so its new
    // notification stays.
    w.pushes.observe([stageCard(FOOTER), stageCard(LOGIN, { currentUpdateSeen: true })]);
    await w.push(FOOTER);
    const footerReply = w.pushNames()[2];
    await w.pass(WITHDRAW_SPACING_MS);
    expect(w.cards().at(-1)).toEqual([
      { cardId: LOGIN, pushes: [login] },
      { cardId: FOOTER, pushes: [footerFirst] },
    ]);

    // The reply is seen while a withdrawal waits for its spacing, and the
    // phone reaches its computer and hands the same address and key again:
    // the waiting withdrawal still goes, since a seen card that stays on the
    // stage keeps its notifications on the phone.
    w.pushes.observe([stageCard(FOOTER, { currentUpdateSeen: true })]);
    await w.pushes.settled();
    w.handAgain();
    expect(w.cards()).toHaveLength(2);
    await w.pass(WITHDRAW_SPACING_MS);
    expect(w.cards().at(-1)).toEqual([
      { cardId: FOOTER, pushes: [footerFirst, footerReply] },
      { cardId: LOGIN, pushes: [login] },
    ]);

    // A new address and key forget the pushes sent to the old ones.
    await w.push(DOCS);
    const anew = w.handAnew();
    w.pushes.observe([stageCard(DOCS, { currentUpdateSeen: true })]);
    await w.pass(WITHDRAW_SPACING_MS);
    expect(w.withdrawalsTo(anew)).toEqual([]);
  });

  it("keeps every push of a card the relay took, whichever answer comes first", async () => {
    const w = withdrawing();
    // The first push's answer is held while the author's reply is pushed and answered.
    const release = w.holdNextPush();
    w.pushes.send({ ...NOTICE, cardId: FOOTER });
    w.pushes.observe([stageCard(FOOTER)]);
    w.pushes.send({ ...NOTICE, cardId: FOOTER });
    // Every answer but the held one is read before the next turn of the event loop.
    await new Promise((resolve) => setImmediate(resolve));
    w.pushes.observe([stageCard(FOOTER, { currentUpdateSeen: true })]);
    await new Promise((resolve) => setImmediate(resolve));
    // The relay records the held push once it answers it, after the reply.
    const [reply] = w.pushNames();
    expect(w.cards()).toEqual([[{ cardId: FOOTER, pushes: [reply] }]]);
    // The older answer arrives before the next withdrawal's spacing is over.
    release();
    await w.pushes.settled();
    const [, first] = w.pushNames();
    expect(first).not.toBe(reply);
    await w.pass(WITHDRAW_SPACING_MS);
    expect(w.cards().at(-1)).toEqual([{ cardId: FOOTER, pushes: [reply, first] }]);
  });

  it("withdraws a card seen while its push was answered across a hand-over to the same address and key", async () => {
    const w = withdrawing();
    const release = w.holdNextPush();
    w.pushes.send({ ...NOTICE, cardId: FOOTER });
    w.handAgain();
    w.pushes.observe([stageCard(FOOTER, { currentUpdateSeen: true })]);
    release();
    await w.pushes.settled();
    expect(w.cards()).toEqual([[{ cardId: FOOTER, pushes: w.pushNames() }]]);
  });

  it("withdraws a push whose card was seen before the relay answered it, though a newer update now waits unread", async () => {
    const w = withdrawing();
    const release = w.holdNextPush();
    w.pushes.send({ ...NOTICE, cardId: FOOTER });
    w.pushes.observe([stageCard(FOOTER, { currentUpdateSeen: true })]);
    // Its author answers before the relay does: the card waits unread again,
    // and the reply is pushed and answered.
    w.pushes.observe([stageCard(FOOTER)]);
    w.pushes.send({ ...NOTICE, cardId: FOOTER });
    await new Promise((resolve) => setImmediate(resolve));
    expect(w.withdrawals()).toEqual([]);
    release();
    await w.pushes.settled();
    // The relay records the held push once it answers it, after the reply.
    const [reply, first] = w.pushNames();
    expect(w.cards()).toEqual([[{ cardId: FOOTER, pushes: [first] }]]);
    await w.pass(WITHDRAW_SPACING_MS);
    expect(
      w
        .cards()
        .flat()
        .flatMap((card) => card.pushes),
    ).not.toContain(reply);
  });

  it("names the newest pushes of a card pushed too often for one withdrawal to name them all", async () => {
    const w = withdrawing();
    await w.push(LOGIN);
    w.pushes.observe([stageCard(LOGIN, { currentUpdateSeen: true }), stageCard(FOOTER)]);
    for (let at = 0; at < 300; at++) w.pushes.send({ ...NOTICE, cardId: FOOTER });
    await w.pushes.settled();
    w.pushes.observe([stageCard(FOOTER, { currentUpdateSeen: true })]);
    await w.pass(WITHDRAW_SPACING_MS);
    const footer = w.pushNames().slice(1);
    const [named] = w.cards().at(-1) ?? [];
    expect(named?.cardId).toBe(FOOTER);
    expect(named?.pushes.length).toBeGreaterThan(100);
    expect(named?.pushes).toEqual(footer.slice(-(named?.pushes.length ?? 0)));
  });

  it("names pushes no withdrawal named yet before a card's long history, and sends the rest later", async () => {
    const w = withdrawing();
    for (let at = 0; at < 300; at++) w.pushes.send({ ...NOTICE, cardId: FOOTER });
    await w.push(LOGIN);
    w.pushes.observe([stageCard(FOOTER, { currentUpdateSeen: true }), stageCard(LOGIN)]);
    await w.pushes.settled();
    // One card's 300 pushes do not fit one withdrawal: what is left goes in
    // the next ones, a spacing apart, until every push was named once.
    const footer = w.pushNames().slice(0, 300);
    for (let round = 0; round < 4; round++) await w.pass(WITHDRAW_SPACING_MS);
    const named = w.cards().flatMap((cards) => cards.flatMap((card) => card.pushes));
    expect(new Set(named)).toEqual(new Set(footer));
    expect(w.cards().length).toBeGreaterThan(1);

    // The first card is pushed again, then seen as the other is answered:
    // the first card is newest on the list with its long history, and both
    // pushes still to go are named.
    w.pushes.observe([stageCard(FOOTER), stageCard(LOGIN)]);
    await w.push(FOOTER);
    w.pushes.observe([
      stageCard(FOOTER, { currentUpdateSeen: true }),
      stageCard(LOGIN, { awaiting: "answer" }),
    ]);
    await w.pass(WITHDRAW_SPACING_MS);
    const [login, reply] = w.pushNames().slice(300);
    const last = w.cards().at(-1) ?? [];
    expect(last[0]?.cardId).toBe(FOOTER);
    expect(last[0]?.pushes.at(-1)).toBe(reply);
    expect(last.find((card) => card.cardId === LOGIN)?.pushes).toEqual([login]);
  });

  it("names as many of the newest cards as Apple's payload holds", async () => {
    const w = withdrawing();
    const ids = Array.from(
      { length: 120 },
      (_, at) =>
        `card-${at.toString(16).padStart(8, "0")}-merge-${"settings-panel".slice(0, 6 + (at % 9))}`,
    );
    await w.push(...ids);
    w.pushes.observe(ids.map((id) => stageCard(id)));
    // Every one leaves the stage at once.
    w.pushes.observe([]);
    await w.pushes.settled();
    const last = w.relay.posts.filter((post) => post.url.endsWith("/v1/withdraw")).at(-1);
    const { sealed } = phonePushRelayRequestSchema.parse(JSON.parse(last?.body ?? ""));
    // The relay wraps it as its withdraw route does.
    const apple = JSON.stringify({ aps: { "content-available": 1 }, sealed });
    expect(Buffer.byteLength(apple)).toBeLessThanOrEqual(APPLE_PAYLOAD_LIMIT);
    const named = w.withdrawals().at(-1) ?? [];
    expect(named.length).toBeGreaterThan(30);
    expect(named.length).toBeLessThan(ids.length);
    // One more card would not fit.
    const oneMore = Math.ceil(
      ((12 +
        16 +
        Buffer.byteLength(
          JSON.stringify({ v: 1, kind: "withdraw", cards: w.withdrawalsTo(w.phone).at(-1)?.cards }),
        ) +
        1 +
        Buffer.byteLength(
          JSON.stringify({
            cardId: ids.find((id) => !named.includes(id)),
            pushes: w.withdrawalsTo(w.phone).at(-1)?.cards[0]?.pushes,
          }),
        )) *
        4) /
        3,
    );
    expect(Buffer.byteLength(apple) - sealed.length + oneMore).toBeGreaterThan(APPLE_PAYLOAD_LIMIT);
  });

  it.each([
    [410, true],
    [403, true],
  ])("forgets the registration a withdrawal is answered %i for", async (status) => {
    const w = withdrawing();
    await w.push(FOOTER);
    w.relay.answer.status = status;
    w.pushes.observe([stageCard(FOOTER, { currentUpdateSeen: true })]);
    await w.pushes.settled();
    expect(w.forgotten).toEqual([PHONE]);
  });

  it("holds a phone's withdrawal after a 429 to it and every phone's after a 503, while other pushes go on", async () => {
    const w = withdrawing(204, { tabletWithdraws: true });
    const PUSH = "https://relay.test/v1/push";
    const WITHDRAW = "https://relay.test/v1/withdraw";
    const to = (token: string, url: string) =>
      w.sent.filter((request) => request.token === token && request.url === url);
    // The computer broadcasts each card before it pushes it; `seen` marks those seen.
    const shown: string[] = [];
    const seen = new Set<string>();
    const broadcast = () =>
      w.pushes.observe(shown.map((id) => stageCard(id, { currentUpdateSeen: seen.has(id) })));
    const show = async (...ids: string[]) => {
      shown.push(...ids);
      broadcast();
      await w.push(...ids);
    };
    const see = async (id: string) => {
      seen.add(id);
      broadcast();
      await w.pushes.settled();
    };
    await show(FOOTER, LOGIN, VENUE, DOCS);

    // The relay asks the phone, alone, to wait a minute.
    const start = w.clock.now;
    w.answers.answerFor = (url, token) =>
      url === PUSH && token === w.phone.token ? 429 : undefined;
    await show("card-41aa09c2-new-reply");
    w.answers.answerFor = undefined;
    // The tablet's first withdrawal goes at once; the phone's waits for its minute.
    await see(FOOTER);
    expect(to(w.tablet.token, WITHDRAW).map((request) => request.at)).toEqual([start]);
    expect(to(w.phone.token, WITHDRAW)).toEqual([]);
    // A card push during the phone's minute reaches the tablet alone.
    const pushesBefore = [to(w.phone.token, PUSH).length, to(w.tablet.token, PUSH).length];
    await show("card-52bb10d3-during-wait");
    expect([to(w.phone.token, PUSH).length, to(w.tablet.token, PUSH).length]).toEqual([
      pushesBefore[0],
      (pushesBefore[1] ?? 0) + 1,
    ]);
    await w.pass(60_000 - 1);
    expect(to(w.phone.token, WITHDRAW)).toEqual([]);
    await w.pass(1);
    expect(to(w.phone.token, WITHDRAW).map((request) => request.at)).toEqual([start + 60_000]);
    expect(
      w.withdrawalsTo(w.phone).map((withdrawal) => withdrawal.cards.map((card) => card.cardId)),
    ).toEqual([[FOOTER]]);
    expect(
      w.withdrawalsTo(w.tablet).map((withdrawal) => withdrawal.cards.map((card) => card.cardId)),
    ).toEqual([[FOOTER]]);

    // After both spacings, the relay itself is not ready: every phone waits its minute.
    await w.pass(WITHDRAW_SPACING_MS);
    const unready = w.clock.now;
    w.answers.answerFor = (url) => (url === PUSH ? 503 : undefined);
    await show("card-63cc21e4-relay-busy");
    w.answers.answerFor = undefined;
    await see(LOGIN);
    const sentBefore = w.sent.length;
    // No card push goes in that minute either.
    await show("card-74dd32f5-in-the-minute");
    expect(w.sent).toHaveLength(sentBefore);
    await w.pass(60_000);
    for (const token of [w.phone.token, w.tablet.token])
      expect(to(token, WITHDRAW).at(-1)?.at).toBe(unready + 60_000);
    expect(
      w
        .withdrawalsTo(w.phone)
        .at(-1)
        ?.cards.map((card) => card.cardId),
    ).toEqual([LOGIN, FOOTER]);
    expect(
      w
        .withdrawalsTo(w.tablet)
        .at(-1)
        ?.cards.map((card) => card.cardId),
    ).toEqual([LOGIN, FOOTER]);

    // A relay without the withdraw request answers 404: one line, and card pushes go on.
    w.relay.answer.status = 404;
    w.answers.answerFor = (url) => (url === PUSH ? 204 : undefined);
    await see(VENUE);
    await w.pass(WITHDRAW_SPACING_MS);
    await show("card-85ee43a6-after-old-relay");
    expect(w.relay.posts.at(-1)?.url).toBe(PUSH);
    expect(w.problems).toEqual([
      "the push relay refused a card push with 429",
      "the push relay refused a card push with 503",
      "the push relay refused a card push with 503",
      "the push relay refused a withdrawal with 404",
      "the push relay refused a withdrawal with 404",
    ]);
  });
});
