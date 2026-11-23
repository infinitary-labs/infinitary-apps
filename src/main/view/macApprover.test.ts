import { approvalCode } from "@core/secrets/approvals";
import { httpSecretBroker } from "@core/secrets/httpBroker";
import { ProtectedSecrets } from "@core/secrets/protected";
import { SecretsSettings } from "@core/secrets/settings";
import type { Card } from "@shared/cards";
import {
  SECRET_DEVICE_WORDS,
  SECRET_MAC_WORDS,
  SECRETS_WORDS,
  type SecretEntryInput,
} from "@shared/secrets";
import { describe, expect, it, vi } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { asAView } from "../../core/askedFromAView";
import { MacApprover } from "./macApprover";

// Intent: INF-4207 piece 6, decision 8: "Another Mac approving secret uses with
// its own Touch ID: yes, set up once on the home, like a phone". The captain's
// checks: "an approval from a second Mac, a refusal for a Mac never set up".
// The home's Secrets are the real owner and the Mac's approver the real one,
// joined as the view's link joins them (every request asked as that paired
// view); both custodies and both confirmations are stand-ins, so no Keychain
// or Touch ID is reached.
const TOKEN = "ya29.invented-mac-approver-token";
const INPUT = {
  ref: "calendar",
  label: "Planning calendar",
  value: TOKEN,
  expectedVersion: 0,
  expectedRevision: null,
  environment: "Personal",
} satisfies SecretEntryInput;
type Raised = Omit<Card, "author" | "priority" | "status" | "createdAt">;
/** The paired Mac's id on the home: what the connection names for its requests. */
const PAIRED = "studio-mac";

function world() {
  const cards: Raised[] = [];
  const sent: string[] = [];
  let homeConfirms = 0;
  const settings = new SecretsSettings({
    open: (initialize) =>
      ProtectedSecrets.open({
        dir: scratchDir("mac-approver-home-"),
        custody: disposableCustody(),
        initialize,
        environment: () => ({}),
        authentication: {
          available: async () => true,
          confirm: async () => {
            homeConfirms += 1;
            return true;
          },
        },
      }),
    raise: (card) => {
      cards.push(card);
    },
    withdraw: () => {},
    changed: () => {},
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
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    }),
  );
  /** What the view's link does: each request reaches the home as this paired Mac's. */
  const invoke = async (channel: string, args: unknown[]): Promise<unknown> =>
    asAView(
      () => {
        const [input] = args as [never];
        if (channel === "inf:secrets:approvals")
          return settings.approvals((input as { device: string }).device);
        if (channel === "inf:secrets:enroll") return settings.enroll(input);
        if (channel === "inf:secrets:decide") return settings.decideRemotely(input);
        throw new Error(`Not a Secrets request: ${channel}`);
      },
      { view: PAIRED },
    );
  const macCustody = disposableCustody();
  let touchId = true;
  let macConfirms = 0;
  const approver = (able = true) =>
    new MacApprover({
      host: () =>
        able
          ? {
              custody: macCustody,
              authentication: {
                available: async () => true,
                confirm: async () => {
                  macConfirms += 1;
                  return touchId;
                },
              },
            }
          : undefined,
      label: () => "Studio Mac",
      home: () => "MacBook Pro",
      invoke: (channel, args) => invoke(channel, args),
    });
  const pass = (label: string, card = cards.at(-1)) => {
    const action = card?.actions.find((one) => one.label === label);
    if (!action) throw new Error("No action with that label.");
    return { card: card?.id ?? "", action: action.id };
  };
  const ask = async () => {
    const receipt = await settings.broker({
      id: `read-${cards.length}`,
      reason: "Read my next planning meeting",
      broker: "calendar",
      input: { calendar: "primary" },
    });
    expect(receipt.state).toBe("waiting");
    return receipt;
  };
  const state = async (request: string) =>
    (await settings.view()).uses.find((one) => one.request === request)?.state;
  return {
    settings,
    cards,
    sent,
    approver,
    pass,
    ask,
    state,
    macCustody,
    homeConfirms: () => homeConfirms,
    macConfirms: () => macConfirms,
    touchId: (value: boolean) => {
      touchId = value;
    },
  };
}

/** The captain turns on the Mac's switch on the home, the Mac offers its key, and the captain confirms there. */
async function setUp(w: ReturnType<typeof world>, mac: MacApprover) {
  await w.settings.action({ kind: "ask-phone", paired: PAIRED });
  await mac.refresh();
  const card = w.cards.at(-1);
  expect(card?.title).toBe(SECRET_DEVICE_WORDS.enrollTitle("Studio Mac"));
  const effect = card?.actions.find((one) => one.label === SECRET_DEVICE_WORDS.confirm)?.effect;
  if (effect?.kind !== "host" || !effect.arg) throw new Error("No confirm action.");
  return { card, confirm: () => w.settings.decide(effect.arg as string) };
}

describe("a Mac that approves Secrets uses for another computer", () => {
  it("is set up once on the home by comparing codes, then allows one use with its own confirmation", async () => {
    const w = world();
    await w.settings.put(INPUT);
    const mac = w.approver();
    const { card, confirm } = await setUp(w, mac);
    // The code the Mac shows comes from the key it keeps; the home's card shows the key it received.
    const held = JSON.parse(w.macCustody.slots.get("root")?.toString("utf8") ?? "{}") as {
      publicKey: string;
    };
    const code = approvalCode(held.publicKey);
    expect(card?.body).toContain(code);
    const [shown] = mac.shown([card]) as [Raised];
    expect(shown.body).toContain(SECRET_MAC_WORDS.code(code));
    await confirm();
    expect((await w.settings.view()).devices).toMatchObject([{ label: "Studio Mac" }]);

    const receipt = await w.ask();
    // Set up, its window offers Allow once and Don't allow, as a phone does; a lasting allowance stays the home's.
    await mac.refresh();
    const [useShown] = mac.shown([w.cards.at(-1)]) as [Raised];
    expect(useShown.actions.map((action) => action.label)).toEqual([
      SECRETS_WORDS.once,
      SECRETS_WORDS.deny,
    ]);
    expect(useShown.body).toContain(SECRET_MAC_WORDS.saveOnHome("MacBook Pro"));
    expect(useShown.body).not.toContain(SECRET_MAC_WORDS.notSetUp("MacBook Pro"));
    const homeConfirms = w.homeConfirms();
    const allow = w.pass(SECRETS_WORDS.once);
    expect(await mac.act(allow.card, allow.action)).toEqual({});
    expect(w.macConfirms()).toBe(1);
    expect(w.homeConfirms()).toBe(homeConfirms);
    await vi.waitFor(async () => expect(await w.state(receipt.request)).toBe("completed"));
    expect(w.sent).toEqual([`Bearer ${TOKEN}`]);
    expect(
      (await w.settings.view()).history.find((one) => one.request === receipt.request),
    ).toMatchObject({ approval: "remote" });

    const next = await w.ask();
    w.touchId(false);
    const again = w.pass(SECRETS_WORDS.once);
    expect(await mac.act(again.card, again.action)).toEqual({
      refusal: SECRET_MAC_WORDS.notConfirmed,
    });
    expect(await w.state(next.request)).toBe("waiting");
    // A lasting allowance is the home's to give; a refusal needs no key and goes there as pressed.
    const always = w.pass(SECRETS_WORDS.short);
    expect(await mac.act(always.card, always.action)).toEqual({
      refusal: SECRET_MAC_WORDS.saveOnHome("MacBook Pro"),
    });
    const deny = w.pass(SECRETS_WORDS.deny);
    expect(await mac.act(deny.card, deny.action)).toBeUndefined();
    expect(w.sent).toHaveLength(1);
  });

  it("refuses an Allow on a Mac never set up, and the home does not take that press as its own", async () => {
    const w = world();
    await w.settings.put(INPUT);
    const receipt = await w.ask();
    const allow = w.pass(SECRETS_WORDS.once);
    const refused = { refusal: SECRET_MAC_WORDS.notSetUp("MacBook Pro") };
    // A Mac that keeps a key the home never confirmed, and one that cannot keep a key at all.
    const unconfirmed = w.approver();
    await w.settings.action({ kind: "ask-phone", paired: PAIRED });
    await unconfirmed.refresh();
    const use = w.cards.find((one) => one.id === allow.card);
    const [shown] = unconfirmed.shown([use]) as [Raised];
    expect(shown.actions.map((action) => action.label)).toEqual([SECRETS_WORDS.deny]);
    expect(shown.body).toContain(SECRET_MAC_WORDS.notSetUp("MacBook Pro"));
    expect(await unconfirmed.act(allow.card, allow.action)).toEqual(refused);
    // A window that can keep no key, as on Linux, says where to answer instead of a switch it lacks.
    const unable = w.approver(false);
    const [unableShown] = unable.shown([use]) as [Raised];
    expect(unableShown.actions.map((action) => action.label)).toEqual([SECRETS_WORDS.deny]);
    expect(unableShown.body).toContain(SECRET_MAC_WORDS.cannotApprove("MacBook Pro"));
    expect(unableShown.body).not.toContain(SECRET_MAC_WORDS.notSetUp("MacBook Pro"));
    expect(await unable.act(allow.card, allow.action)).toEqual({
      refusal: SECRET_MAC_WORDS.cannotApprove("MacBook Pro"),
    });
    expect(w.macConfirms()).toBe(0);

    // The same press reaching the home from that Mac's window is left unspent.
    const homeConfirms = w.homeConfirms();
    await asAView(() => w.settings.decide(allow.action), { view: PAIRED });
    expect(w.homeConfirms()).toBe(homeConfirms);
    expect(await w.state(receipt.request)).toBe("waiting");
    expect(w.sent).toEqual([]);
    await w.settings.decide(w.pass(SECRETS_WORDS.once, use).action);
    await vi.waitFor(async () => expect(await w.state(receipt.request)).toBe("completed"));
    expect(w.sent).toEqual([`Bearer ${TOKEN}`]);
  });
});
