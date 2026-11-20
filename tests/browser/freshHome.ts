import { type CardDraft, type CardDraftChange, emptyDraft } from "@shared/cardDrafts";
import { DEFAULT_SAVED_KEYMAP } from "@shared/keymap";
import { DEFAULT_KEY_REMINDERS } from "@shared/keyReminders";
import { frameMountUrl } from "@shared/plugins/frameDocument";
import { inject } from "vitest";
import { commands } from "vitest/browser";
import "../helpers/browserProvided";
import { InstalledKeymap } from "../../src/main/keyboard";
import { builtinManifest } from "../../src/renderer/src/plugins/builtin/manifest";
import type { FreshHomeAnswers } from "../helpers/browserProvided";
import { type Answers, NoAnswer } from "./bridge";

/**
 * The answers a fresh home gives the window (docs/testing.md, "The browser
 * layer"): the core's own, read from a real core booted once per run
 * (tests/helpers/browserFreshHome.ts), and the desktop shell's, given by the shell's own
 * code where it has a part that runs in a page. A test passes them to
 * `fakeBridge` and replaces only the answers its story changes.
 */
export function freshHome(): Answers {
  return homeAnswers(inject("freshHome"));
}

/**
 * The answers a seeded home gives the window: the core's own, read from a
 * real core booted on a data folder the test's seed wrote first
 * (tests/helpers/browserHomes/, named as the test file is) from `input`,
 * and the desktop shell's, as `freshHome` gives them.
 */
export async function seededHome(input?: unknown): Promise<Answers> {
  return homeAnswers(await commands.seededHome(input));
}

/**
 * The Settings sections the app declares that `home` offers: Secrets only
 * where the home keeps protected storage, as its own answer says
 * (docs/secrets.md), which a fresh home does not.
 */
export function offeredSettingsSections(home: Answers) {
  const secrets = home["inf:secrets:shown"];
  const secretsShown = typeof secrets === "object" && secrets.shown;
  return builtinManifest.contributes.settingsSections.filter(
    (section) => section.id !== "secrets" || secretsShown,
  );
}

/**
 * `home` once its person has connected a subscription: the first-run gate is
 * closed and the message box is open.
 */
export function subscribed(home: Answers): Answers {
  const firstRun = home["inf:app:first-run"];
  if (!firstRun || typeof firstRun === "function") throw new Error("The home answers no first run");
  return { ...home, "inf:app:first-run": { ...firstRun, gateOpen: false } };
}

function homeAnswers({ plain, asked }: FreshHomeAnswers): Answers {
  // The shell's installed keys, as main holds them for a home that changed none.
  const keymap = new InstalledKeymap({
    keymap: () => ({ saved: DEFAULT_SAVED_KEYMAP, unreadable: false }),
    setKeymap: () => {},
    subscribe: () => () => {},
  });
  let mounts = 0;
  const drafts = draftStandIn(
    ((plain as Answers)["inf:cards:drafts"] as CardDraft[] | undefined) ?? [],
  );
  const askedAnswers = Object.fromEntries(
    Object.entries(asked).map(([channel, byRequest]) => [
      channel,
      (...request: unknown[]) => {
        const key = JSON.stringify(request);
        if (!(key in byRequest))
          throw new NoAnswer(
            `The home read ${channel} only for ${Object.keys(byRequest).join(", ")}, not ${key}; add it to ASKED in tests/helpers/browserFreshHome.ts, to the seed's asked, or answer it in the test`,
          );
        return byRequest[key];
      },
    ]),
  );
  return {
    ...(plain as Answers),
    ...(askedAnswers as Answers),
    "inf:keyboard:keymap": () => keymap.current(),
    "inf:keyboard:panels": (panels) => keymap.setPanels(panels),
    // A new profile's key reminders (src/main/keyReminders.ts reads its missing file as this).
    "inf:keyboard:reminders": DEFAULT_KEY_REMINDERS,
    "inf:devices:this-mac": { role: "home", left: null },
    "inf:voice:recognizer": { where: "window" },
    // The card a notification's click asked the window to open: none, as nothing was clicked.
    "inf:cards:take-notified": { cardId: null },
    // A frame's document is served over the shell's own scheme, which a page
    // cannot load: the frame mounts and stays empty, as a frame that is still loading.
    "inf:frames:mount": () => {
      mounts += 1;
      const mountId = `browser-${mounts}`;
      return { mountId, url: frameMountUrl(mountId) };
    },
    "inf:frames:unmount": { ok: true },
    // What the window tells the core at startup, accepted as the core accepts it.
    "inf:plugins:personal:mounts": { ok: true },
    // A card's unsent draft (docs/card-authoring.md, "Unsent picks follow
    // you"), kept as the core keeps it (`draftStandIn`).
    "inf:cards:draft": drafts.change,
  };
}

/**
 * The first mate's computer's drafts as `CardDrafts` keeps them, for a
 * browser test, which draws one window: `change` answers that window's
 * `inf:cards:draft` request, and `elsewhere` is another window's change,
 * whose draft the test pushes. A part changed after the request's `since`
 * keeps the newer value, and every part taken moves to one new revision.
 */
export function draftStandIn(seed: readonly CardDraft[]) {
  const drafts = new Map(seed.map((draft) => [draft.cardId, draft]));
  // Each part's revision, by card: a seeded part counts from its draft's.
  const revisions = new Map<string, Map<string, number>>();
  const partsOf = (change: Omit<CardDraftChange, "since">) => [
    ...(change.answers ?? []).map((answer) => `answer:${answer.name}`),
    ...(change.words !== undefined ? ["words"] : []),
    ...(change.notes !== undefined ? ["notes"] : []),
  ];
  const change = (cardId: string, asked: CardDraftChange): { draft: CardDraft } => {
    const held = drafts.get(cardId) ?? emptyDraft(cardId);
    const kept = revisions.get(cardId) ?? new Map<string, number>();
    const newer = (part: string) => (kept.get(part) ?? 0) > asked.since;
    const revision = held.revision + 1;
    const answers = new Map(held.answers.map((answer) => [answer.name, answer]));
    for (const answer of asked.answers ?? [])
      if (!newer(`answer:${answer.name}`)) answers.set(answer.name, answer);
    const draft: CardDraft = {
      ...held,
      revision,
      answers: [...answers.values()],
      words: asked.words !== undefined && !newer("words") ? asked.words : held.words,
      notes: asked.notes !== undefined && !newer("notes") ? asked.notes : held.notes,
    };
    for (const part of partsOf(asked)) if (!newer(part)) kept.set(part, revision);
    revisions.set(cardId, kept);
    drafts.set(cardId, draft);
    return { draft };
  };
  return {
    change,
    /** Another window's change, taken over everything this window sent: the draft to push. */
    elsewhere: (cardId: string, parts: Omit<CardDraftChange, "since">): CardDraft =>
      change(cardId, { ...parts, since: drafts.get(cardId)?.revision ?? 0 }).draft,
  };
}
