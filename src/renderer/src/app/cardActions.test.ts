import type { CardNote } from "@shared/cardNotes";
import {
  ANYTHING_ELSE_ANSWER,
  CARD_ANSWER_TEXT_MAX,
  CARD_ANSWERS_TOO_LONG,
  type ShellEffect,
} from "@shared/cards";
import { ENDED_CLOSE, ENDED_CORNER, endedLineWords } from "@shared/endedCard";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageAttachment } from "../design";
import { useShellStore } from "./store";
import { card, DECIDE, gesture, resetShell } from "./storeTestKit";

/** A note queued in a card's field, as point-at makes one. */
const NOTE: CardNote = {
  start: 0,
  key: "p:0",
  kind: "paragraph",
  excerpt: "Choose.",
  comment: "Use the work account",
  line: 1,
};
/** A picture pasted into a card's field: the smallest real PNG, one transparent pixel. */
const PICTURE: ImageAttachment = {
  id: "picture-1",
  preview: "",
  name: "screen.png",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HJ3AAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
};
/** A request card's open-browser effect, as the core answers it. */
const OPENED = {
  kind: "open",
  target: "browser",
  browser: { taskId: "t1", session: "run-1", generation: 2, cardId: "choice" },
} as const;

/** What the captain does on a card (./cardActions.ts): a choice's receipt and its effects. */

describe("card action receipts", () => {
  const ready = card({ id: "choice", status: "ready", actions: DECIDE, body: "Choose." });
  function request() {
    const replies: {
      resolve: (value: { effect?: ShellEffect; refusal?: string }) => void;
      reject: (error: Error) => void;
    }[] = [];
    const act = vi.fn(
      () =>
        new Promise<{ effect?: ShellEffect; refusal?: string }>((resolve, reject) => {
          replies.push({ resolve, reject });
        }),
    );
    vi.stubGlobal("window", { infinitary: { cards: { act } } });
    useShellStore.setState({ cards: [ready], cardIndex: 0, records: [] });
    return {
      act,
      replies,
      resolve: (value: { effect?: ShellEffect; refusal?: string } = {}) =>
        replies.at(-1)?.resolve(value),
      reject: (error: Error) => replies.at(-1)?.reject(error),
    };
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    resetShell();
  });

  // The captain's Approve and build on INF-924: one field under the card;
  // Enter or Chat sends its words as a reply, any other button sends them
  // with the choice, as the answer the agents already read.
  it("sends the field's words with a clicked choice and empties the field once accepted", async () => {
    const ipc = request();
    useShellStore.getState().setReplyDraft("choice", "Check the light theme too");
    const sent = useShellStore
      .getState()
      .actOnCard("choice", "land", "chrome", undefined, async () => undefined);
    await vi.waitFor(() => expect(ipc.act).toHaveBeenCalledTimes(1));
    // The click's value: the answers it carries, the field's words among them.
    expect((ipc.act.mock.calls[0] as unknown[] | undefined)?.[3]).toEqual({
      answers: [
        {
          name: ANYTHING_ELSE_ANSWER,
          values: [],
          changed: true,
          written: "Check the light theme too",
        },
      ],
    });
    expect(useShellStore.getState().replyDrafts.choice).toBe("Check the light theme too");
    ipc.resolve();
    await sent;
    expect(useShellStore.getState().replyDrafts.choice).toBeUndefined();
  });

  it("keeps the field's words when the choice is refused", async () => {
    const ipc = request();
    useShellStore.getState().setReplyDraft("choice", "Check the light theme too");
    const sent = useShellStore
      .getState()
      .actOnCard("choice", "land", "chrome", undefined, async () => undefined);
    await vi.waitFor(() => expect(ipc.act).toHaveBeenCalledTimes(1));
    ipc.resolve({ refusal: "This card was already answered." });
    await sent;
    expect(useShellStore.getState().replyDrafts.choice).toBe("Check the light theme too");
    useShellStore.setState({ replyDrafts: {} });
  });

  it("sets pending before IPC, deduplicates same and sibling actions, and clears on acceptance", async () => {
    const ipc = request();
    const send = ipc.act.getMockImplementation();
    if (!send) throw new Error("Missing controlled IPC implementation.");
    ipc.act.mockImplementationOnce(() => {
      expect(useShellStore.getState().pendingCardActions.choice).toEqual({ actionId: "land" });
      return send();
    });
    const first = useShellStore.getState().actOnCard("choice", "land");
    expect(useShellStore.getState().pendingCardActions.choice).toEqual({ actionId: "land" });
    await useShellStore.getState().actOnCard("choice", "land");
    await useShellStore.getState().actOnCard("choice", "discard");
    expect(ipc.act).toHaveBeenCalledTimes(1);
    expect(ipc.act).toHaveBeenCalledWith("choice", "land", "chrome", undefined, gesture());
    // A push that still contains this card never resets its pending guard.
    useShellStore.getState().applyCards([ready]);
    expect(useShellStore.getState().pendingCardActions.choice).toBeDefined();
    ipc.resolve();
    await first;
    expect(useShellStore.getState().pendingCardActions).toEqual({});
    expect(useShellStore.getState().cards).toEqual([]);
    await useShellStore.getState().actOnCard("choice", "land");
    expect(ipc.act).toHaveBeenCalledTimes(1);
  });

  it("retains an open card on a typed refusal without accepting it or applying an effect", async () => {
    const ipc = request();
    const sent = useShellStore.getState().actOnCard("choice", "land");
    ipc.resolve({
      refusal: "The choice is unavailable.",
      effect: { kind: "open", target: "settings" },
    });
    await sent;
    expect(useShellStore.getState()).toMatchObject({
      cards: [ready],
      pendingCardActions: {},
      view: "home",
      cardActionErrors: { choice: "The choice is unavailable." },
    });
  });

  // INF-1007 direction A: every forge host sign-in lives in Integrations;
  // older cards still naming Projects retain the host to start on arrival.
  it("routes every forge host sign-in card into Integrations and starts that host's sign-in", async () => {
    for (const host of [
      "github.com",
      "gitlab.com",
      "gitlab.example.com",
      "github.example.com",
      "gitlab:code.example.com",
      "github-enterprise:code.example.com",
    ]) {
      const ipc = request();
      const sent = useShellStore.getState().actOnCard("choice", "sign-in");
      ipc.resolve({ effect: { kind: "open", target: "projects", signIn: host } });
      await sent;
      expect(useShellStore.getState()).toMatchObject({
        view: "settings",
        settingsSection: "integrations",
        pendingForgeSignIn: host,
      });
    }
  });

  // docs/fleet.md, "A folder that is not there": the first mate's Choose
  // folder button adds the folder picked before its click goes, so the first
  // mate hears the click once the project is on the list.
  it("adds the folder a Choose folder button picks before sending its click", async () => {
    const choose = card({
      id: "which-folder",
      status: "ready",
      body: "No folder exists at ~/code/meter. Which folder did you mean?",
      actions: [
        {
          id: "choose",
          label: "Choose folder",
          default: true,
          effect: { kind: "open", target: "projects", folder: true },
        },
        { id: "not-now", label: "Not now" },
      ],
    });
    const meter = "/Users/someone/github/octo/meter";
    const sent: string[] = [];
    const chooseFolder = vi.fn(async (): Promise<string | null> => null);
    const setup = vi.fn(async (spec: { path: string }) => {
      sent.push(`setup ${spec.path}`);
      return { repo: { id: "repo-meter", name: "meter" }, created: true };
    });
    const act = vi.fn(async () => {
      sent.push("click");
      return { effect: { kind: "open", target: "projects", folder: true } };
    });
    vi.stubGlobal("window", {
      infinitary: { cards: { act }, app: { chooseFolder }, repos: { setup } },
    });
    useShellStore.setState({ cards: [choose], cardIndex: 0, records: [] });

    // Cancel in the picker sends nothing and keeps the card.
    await useShellStore.getState().actOnCard("which-folder", "choose");
    expect(sent).toEqual([]);
    expect(useShellStore.getState()).toMatchObject({
      cards: [choose],
      pendingCardActions: {},
      cardActionErrors: {},
    });

    // A refused folder shows on the card and sends nothing.
    chooseFolder.mockResolvedValueOnce(meter);
    setup.mockRejectedValueOnce(new Error(`${meter} is already inside the fleet root.`));
    await useShellStore.getState().actOnCard("which-folder", "choose");
    expect(sent).toEqual([]);
    expect(useShellStore.getState().cardActionErrors).toEqual({
      "which-folder": `${meter} is already inside the fleet root.`,
    });

    // A pick is added, then the click goes, and the window stays where it is.
    chooseFolder.mockResolvedValueOnce(meter);
    await useShellStore.getState().actOnCard("which-folder", "choose");
    expect(setup).toHaveBeenLastCalledWith({ kind: "adopt", path: meter });
    expect(sent).toEqual([`setup ${meter}`, "click"]);
    expect(useShellStore.getState().view).not.toBe("settings");

    // A view would show its own computer's folders: it opens Settings -> Projects instead.
    useShellStore.setState({
      cards: [choose],
      thisMac: {
        role: "view",
        name: "MacBook Pro",
        address: "192.168.1.20",
        joinedAt: 0,
        contact: "in-reach",
        readOnly: null,
        heardAt: 0,
        caughtUp: 0,
      },
    });
    chooseFolder.mockClear();
    await useShellStore.getState().actOnCard("which-folder", "choose");
    expect(chooseFolder).not.toHaveBeenCalled();
    expect(useShellStore.getState()).toMatchObject({
      view: "settings",
      settingsSection: "projects",
    });
  });

  it("routes a connect or remove card into Devices with what to do on arrival", async () => {
    for (const [effect, arrival] of [
      [{ kind: "open", target: "devices", make: "link" }, { make: "link" }],
      [{ kind: "open", target: "devices", remove: "mac-1" }, { remove: "mac-1" }],
    ] as const) {
      const ipc = request();
      const sent = useShellStore.getState().actOnCard("choice", "open");
      ipc.resolve({ effect });
      await sent;
      expect(useShellStore.getState()).toMatchObject({
        view: "settings",
        settingsSection: "devices",
        pendingDeviceArrival: arrival,
      });
      useShellStore.setState({ pendingDeviceArrival: null, settingsSection: null, view: "home" });
    }
  });

  // INF-3116, answer A, moved by INF-4150's plan: the Allow card lands on
  // Settings -> Integrations, whose Private sites box adds its site.
  it("routes a private site's Allow card into Integrations with the site to add on arrival", async () => {
    const ipc = request();
    const sent = useShellStore.getState().actOnCard("choice", "open");
    ipc.resolve({ effect: { kind: "open", target: "settings", privateSite: "wiki.corp.example" } });
    await sent;
    expect(useShellStore.getState()).toMatchObject({
      view: "settings",
      settingsSection: "integrations",
      pendingPrivateSite: "wiki.corp.example",
    });
    useShellStore.setState({ pendingPrivateSite: null, settingsSection: null, view: "home" });
  });

  it("on a computer controlling another, opens Devices here, and asks for an update first when the first mate there is too old (docs/view.md)", async () => {
    const ipc = request();
    // The pause card, as the host builds it: move Firstmate, or sign in again.
    const paused = card({
      id: "paused",
      author: "host",
      status: "ready",
      body: "Codex needs you to sign in again.",
      actions: [
        {
          id: "move-flagship",
          label: "Move to Grok",
          effect: { kind: "host", op: "move-flagship", arg: "xai" },
        },
        {
          id: "sign-in",
          label: "Sign in",
          effect: { kind: "host", op: "restore-account", arg: "acct_codex" },
        },
      ],
    });
    const link = card({
      id: "link",
      status: "ready",
      body: "Make a link here.",
      actions: [
        {
          id: "open",
          label: "Make a link",
          default: true,
          effect: { kind: "open", target: "devices", make: "link" },
        },
        { id: "not-now", label: "Not now" },
      ],
    });
    const view = {
      role: "view",
      name: "MacBook Pro",
      address: "192.168.1.20",
      joinedAt: 0,
      contact: "in-reach",
      readOnly: null,
      heardAt: 0,
      caughtUp: 0,
    } as const;
    // INF-1352's plan, piece 2: a first mate too old to answer a view's devices is not asked.
    useShellStore.setState({
      cards: [paused, link],
      thisMac: { ...view, devicesNeedUpdateThere: true },
    });
    await useShellStore.getState().actOnCard("link", "open");
    expect(ipc.act).not.toHaveBeenCalled();
    expect(useShellStore.getState()).toMatchObject({
      cards: [paused, link],
      pendingCardActions: {},
      cardActionErrors: {
        link: "Update Infinitary on MacBook Pro to do this from here.",
      },
      view: "home",
      settingsSection: null,
      pendingRestoreAccountId: null,
      pendingDeviceArrival: null,
    });
    // The card's other button is that Mac's to answer, and is sent.
    const moved = useShellStore.getState().actOnCard("paused", "move-flagship");
    expect(ipc.act).toHaveBeenCalledWith("paused", "move-flagship", "chrome", undefined, gesture());
    ipc.resolve();
    await moved;
    expect(useShellStore.getState().cards).toEqual([link]);
    // On a current one, and on the Mac where Firstmate lives, the same click is sent and opens Settings.
    useShellStore.setState({ thisMac: view, cardActionErrors: {} });
    const here = useShellStore.getState().actOnCard("link", "open");
    expect(ipc.act).toHaveBeenLastCalledWith("link", "open", "chrome", undefined, gesture());
    ipc.resolve({ effect: { kind: "open", target: "devices", make: "link" } });
    await here;
    expect(useShellStore.getState()).toMatchObject({
      view: "settings",
      settingsSection: "devices",
      pendingDeviceArrival: { make: "link" },
    });
    useShellStore.setState({
      cards: [link],
      thisMac: { role: "home", left: null },
      view: "home",
      settingsSection: null,
      pendingDeviceArrival: null,
    });
    const opened = useShellStore.getState().actOnCard("link", "open");
    expect(ipc.act).toHaveBeenLastCalledWith("link", "open", "chrome", undefined, gesture());
    ipc.resolve({ effect: { kind: "open", target: "devices", make: "link" } });
    await opened;
    expect(useShellStore.getState()).toMatchObject({
      view: "settings",
      settingsSection: "devices",
      pendingDeviceArrival: { make: "link" },
    });
  });

  // INF-1352's plan, piece 3: any view shows a task's browser; only a first mate too old to
  // send its pictures keeps the take-over there, and says to update it (docs/view.md).
  it("on a Mac controlling an older first mate, sends no take-over of a task's browser and says to update it, while a saved sign-in is sent and opens the page here (docs/view.md)", async () => {
    const ipc = request();
    // A crewmate's request, as the host offers it once a sign-in is saved for its site.
    const asked = card({
      id: "asked",
      taskId: "t1",
      status: "ready",
      body: "The club page needs your sign-in.",
      actions: [
        { id: "leave", label: "Leave waiting" },
        { id: "own", label: "Sign in myself", effect: { kind: "open", target: "browser" } },
        {
          id: "saved",
          label: "Use my saved club.example sign-in",
          default: true,
          effect: { kind: "open", target: "browser", savedSignIn: true },
        },
      ],
    });
    useShellStore.setState({
      cards: [asked],
      thisMac: {
        role: "view",
        name: "MacBook Pro",
        address: "192.168.1.20",
        joinedAt: 0,
        contact: "in-reach",
        readOnly: null,
        heardAt: 0,
        caughtUp: 0,
        browserNeedsUpdateThere: true,
      },
    });
    const own = useShellStore.getState().actOnCard("asked", "own");
    expect(ipc.act).not.toHaveBeenCalled();
    await own;
    expect(useShellStore.getState()).toMatchObject({
      cards: [asked],
      pendingCardActions: {},
      cardActionErrors: {
        asked: "Update Infinitary on MacBook Pro to show this task's browser here.",
      },
      records: [],
    });
    // The saved sign-in needs no one at the page: that Mac answers it, and the page shows here.
    const granted = useShellStore.getState().actOnCard("asked", "saved");
    expect(ipc.act).toHaveBeenCalledWith("asked", "saved", "chrome", undefined, gesture());
    ipc.resolve({
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId: "t1", session: "run-1", generation: 2, cardId: "asked" },
      },
    });
    await granted;
    expect(useShellStore.getState()).toMatchObject({
      cards: [],
      view: "home",
      records: [
        { browserTaskId: "t1", from: { cardId: "asked", session: "run-1", generation: 2 } },
      ],
    });
    useShellStore.setState({ records: [] });
  });

  it("on a Mac controlling a current first mate, sends the take-over and opens the task's browser here (docs/view.md)", async () => {
    const ipc = request();
    useShellStore.setState({
      thisMac: {
        role: "view",
        name: "MacBook Pro",
        address: "192.168.1.20",
        joinedAt: 0,
        contact: "in-reach",
        readOnly: null,
        heardAt: 0,
        caughtUp: 0,
      },
    });
    const sent = useShellStore.getState().actOnCard("choice", "sign-in");
    expect(ipc.act).toHaveBeenCalled();
    ipc.resolve({
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId: "t1", session: "run-1", generation: 2, cardId: "choice" },
      },
    });
    await sent;
    expect(useShellStore.getState()).toMatchObject({
      records: [
        { browserTaskId: "t1", from: { cardId: "choice", session: "run-1", generation: 2 } },
      ],
    });
    useShellStore.setState({ records: [] });
  });

  it('opens a request card\'s task browser view on the stage, never Settings (docs/task-browser.md, "Asking for help")', async () => {
    const ipc = request();
    const sent = useShellStore.getState().actOnCard("choice", "sign-in");
    ipc.resolve({
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId: "t1", session: "run-1", generation: 2, cardId: "choice" },
      },
    });
    await sent;
    expect(useShellStore.getState()).toMatchObject({
      view: "home",
      settingsSection: null,
      records: [
        { browserTaskId: "t1", from: { cardId: "choice", session: "run-1", generation: 2 } },
      ],
      cardIndex: 0,
    });
    useShellStore.setState({ records: [] });
  });

  // INF-4578: the open-browser click leaves the request docked beside the
  // page, so the words in its field wait there to go with Return control.
  it("keeps the field's words in the docked request when its open-browser click answers nothing", async () => {
    const ipc = request();
    useShellStore.getState().setReplyDraft("choice", "Use the second workspace");
    const sent = useShellStore
      .getState()
      .actOnCard("choice", "sign-in", "chrome", undefined, async () => undefined);
    await vi.waitFor(() => expect(ipc.act).toHaveBeenCalledTimes(1));
    ipc.resolve({
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId: "t1", session: "run-1", generation: 2, cardId: "choice" },
      },
    });
    await sent;
    expect(useShellStore.getState().replyDrafts.choice).toBe("Use the second workspace");
    expect(useShellStore.getState().cards.map((shown) => shown.id)).toContain("choice");
    useShellStore.setState({ records: [], replyDrafts: {} });
  });

  // INF-5608's review: a request's open-browser press carries the field like any button. A card
  // that docks beside the page answered nothing, so its field gets back what it held; a card
  // whose browser was gone is answered, and what went went with that answer.
  it("carries the field with a request's open-browser press, and gives it back only when the card docks", async () => {
    const ipc = request();
    useShellStore.setState({ replyNotes: { choice: [NOTE] }, replyImages: { choice: [PICTURE] } });
    const docked = useShellStore
      .getState()
      .actOnCard("choice", "sign-in", "chrome", undefined, async () => undefined);
    await vi.waitFor(() => expect(ipc.act).toHaveBeenCalledTimes(1));
    expect((ipc.act.mock.calls[0] as unknown[] | undefined)?.[3]).toMatchObject({
      notes: [NOTE],
      images: [{ mimeType: "image/png", data: PICTURE.data, name: "screen.png" }],
    });
    expect(useShellStore.getState().replyNotes.choice).toBeUndefined();
    ipc.resolve({ effect: { ...OPENED, browser: { ...OPENED.browser, docked: true } } });
    await docked;
    expect(useShellStore.getState().replyNotes.choice).toEqual([NOTE]);
    expect(useShellStore.getState().replyImages.choice).toEqual([PICTURE]);

    const answered = useShellStore
      .getState()
      .actOnCard("choice", "sign-in", "chrome", undefined, async () => undefined);
    await vi.waitFor(() => expect(ipc.act).toHaveBeenCalledTimes(2));
    ipc.resolve({ effect: OPENED });
    await answered;
    expect(useShellStore.getState().replyNotes.choice).toBeUndefined();
    expect(useShellStore.getState().replyImages.choice).toBeUndefined();
    useShellStore.setState({ records: [] });
  });

  it("keeps an unaccepted card with an honest error and enables a fresh attempt", async () => {
    const ipc = request();
    const first = useShellStore.getState().actOnCard("choice", "land");
    ipc.reject(new Error("The host did not accept the action."));
    await first;
    expect(useShellStore.getState()).toMatchObject({
      cards: [ready],
      pendingCardActions: {},
      cardActionErrors: { choice: "The host did not accept the action." },
    });
    const retry = useShellStore.getState().actOnCard("choice", "land");
    expect(useShellStore.getState().cardActionErrors).toEqual({});
    ipc.resolve();
    await retry;
    expect(ipc.act).toHaveBeenCalledTimes(2);
    expect(useShellStore.getState().cards).toEqual([]);
  });

  it("forwards an explicit settings snapshot unchanged and closes its card", async () => {
    const ipc = request();
    useShellStore.setState({
      cards: [
        {
          ...ready,
          actions: [{ id: "use-settings", label: "Use these settings" }],
        },
      ],
    });
    const value = { planes: [{ name: "inner", speed: 0.5, tiltDeg: 42 }], paused: false };
    const sent = useShellStore.getState().actOnCard("choice", "use-settings", "frame", value);
    expect(ipc.act).toHaveBeenCalledWith("choice", "use-settings", "frame", value, gesture());
    ipc.resolve();
    await sent;
    expect(useShellStore.getState().cards).toHaveLength(0);
  });

  describe("the body's answers ride a footer click (contract 4.22)", () => {
    const withAnswers = card({
      id: "choice",
      status: "ready",
      body: "Choose.",
      actions: [
        { id: "try", label: "Try these" },
        { id: "go", label: "Go", default: true },
      ],
    });
    const speed = { name: "speed", values: ["fast"], labels: ["Fast"], changed: true };
    const scope = { name: "scope", values: [], changed: false };
    const answered = { answered: 2, of: 2, changed: 1, picked: 1, answers: [speed, scope] };
    const partial = { answered: 1, of: 2, changed: 1, picked: 1, answers: [speed, scope] };
    afterEach(resetShell);

    it("sends the frame's fresh reading with the choice", async () => {
      const ipc = request();
      useShellStore.setState({ cards: [withAnswers], cardAnswers: { choice: partial } });
      const sent = useShellStore
        .getState()
        .actOnCard("choice", "go", "chrome", undefined, async () => answered);
      // The guard is up while the frame is read, so a second click waits.
      expect(useShellStore.getState().pendingCardActions.choice).toEqual({ actionId: "go" });
      await vi.waitFor(() => expect(ipc.act).toHaveBeenCalled());
      expect(ipc.act).toHaveBeenCalledWith(
        "choice",
        "go",
        "chrome",
        { answers: [speed, scope] },
        gesture({ reading: "fresh" }),
      );
      ipc.resolve();
      await sent;
    });

    it("falls back on the last reading when the frame gives none", async () => {
      const ipc = request();
      useShellStore.setState({ cards: [withAnswers], cardAnswers: { choice: answered } });
      const sent = useShellStore
        .getState()
        .actOnCard("choice", "go", "chrome", undefined, async () => undefined);
      await vi.waitFor(() => expect(ipc.act).toHaveBeenCalled());
      // The record says the answers were the last draft, not the frame's own.
      expect(ipc.act).toHaveBeenCalledWith(
        "choice",
        "go",
        "chrome",
        { answers: [speed, scope] },
        gesture({ reading: "fallback", questionsGap: "no-fresh-reading" }),
      );
      ipc.resolve();
      await sent;
    });

    it("sends nothing extra from a body with no questions", async () => {
      const ipc = request();
      useShellStore.setState({ cards: [withAnswers] });
      const empty = { answered: 0, of: 0, changed: 0, picked: 0, answers: [] };
      const sent = useShellStore
        .getState()
        .actOnCard("choice", "go", "chrome", undefined, async () => empty);
      await vi.waitFor(() => expect(ipc.act).toHaveBeenCalled());
      expect(ipc.act).toHaveBeenCalledWith("choice", "go", "chrome", undefined, gesture());
      ipc.resolve();
      await sent;
    });

    it("a non-default closing choice sends partial picks", async () => {
      const ipc = request();
      const deferrable = {
        ...withAnswers,
        actions: [...withAnswers.actions, { id: "defer", label: "Not now" }],
      };
      useShellStore.setState({ cards: [deferrable] });
      const sent = useShellStore
        .getState()
        .actOnCard("choice", "defer", "chrome", undefined, async () => partial);
      await vi.waitFor(() => expect(ipc.act).toHaveBeenCalled());
      expect(ipc.act).toHaveBeenCalledWith(
        "choice",
        "defer",
        "chrome",
        { answers: [speed, scope] },
        gesture(),
      );
      ipc.resolve();
      await sent;
      expect(useShellStore.getState().cards).toEqual([]);
    });

    it("holds the default choice until required questions are answered; another sends what there is", async () => {
      const ipc = request();
      useShellStore.setState({ cards: [withAnswers] });
      await useShellStore
        .getState()
        .actOnCard("choice", "go", "chrome", undefined, async () => partial);
      expect(ipc.act).not.toHaveBeenCalled();
      expect(useShellStore.getState()).toMatchObject({
        cards: [withAnswers],
        pendingCardActions: {},
        cardActionErrors: { choice: "Answer every question the card asks first." },
      });

      const sent = useShellStore
        .getState()
        .actOnCard("choice", "try", "chrome", undefined, async () => partial);
      await vi.waitFor(() => expect(ipc.act).toHaveBeenCalled());
      expect(ipc.act).toHaveBeenCalledWith(
        "choice",
        "try",
        "chrome",
        { answers: [speed, scope] },
        gesture(),
      );
      ipc.resolve();
      await sent;
      expect(useShellStore.getState().cards).toEqual([]);
    });

    it("refuses answers past the value bound with an honest error", async () => {
      const ipc = request();
      useShellStore.setState({ cards: [withAnswers] });
      // One value cannot pass the per-value cap and still exceed the set bound.
      const over = Array.from({ length: 5 }, (_, index) => ({
        name: `notes-${index}`,
        values: ["x".repeat(CARD_ANSWER_TEXT_MAX)],
        changed: true,
      }));
      await useShellStore.getState().actOnCard("choice", "go", "chrome", undefined, async () => ({
        answered: over.length,
        of: over.length,
        changed: over.length,
        picked: over.length,
        answers: over,
      }));
      expect(ipc.act).not.toHaveBeenCalled();
      expect(useShellStore.getState().cardActionErrors.choice).toBe(CARD_ANSWERS_TOO_LONG);
    });

    it("reports the offer mounted at the click and the questions the fresh reading defined", async () => {
      const ipc = request();
      const mounted = { ...withAnswers, lifecycleId: "life-1", offerId: "offer-1" };
      useShellStore.setState({ cards: [mounted] });
      const question = {
        name: "speed",
        kind: "single" as const,
        control: "radio" as const,
        prompt: "How fast?",
        promptBasis: "legend" as const,
        options: [],
        defaultBasis: "none" as const,
        required: false,
        gaps: [],
        complete: true,
      };
      const sent = useShellStore.getState().actOnCard(
        "choice",
        "go",
        "chrome",
        undefined,
        async () => {
          // A newer version arrives while the frame is read.
          useShellStore.getState().applyCards([{ ...mounted, offerId: "offer-2" }]);
          return { ...answered, questions: [question] };
        },
        { lifecycleId: "life-1", offerId: "offer-1" },
      );
      await vi.waitFor(() => expect(ipc.act).toHaveBeenCalled());
      // The click names what it was made on, and says the card moved since.
      expect(ipc.act).toHaveBeenCalledWith(
        "choice",
        "go",
        "chrome",
        { answers: [speed, scope] },
        gesture({
          lifecycleId: "life-1",
          offerId: "offer-1",
          reading: "fresh",
          remounted: true,
          questions: [question],
        }),
      );
      ipc.resolve();
      await sent;
    });

    it("keeps a card's reading only while the card is up", () => {
      request();
      useShellStore.setState({ cards: [withAnswers] });
      useShellStore.getState().setCardAnswers("choice", answered);
      useShellStore.getState().applyCards([withAnswers]);
      expect(useShellStore.getState().cardAnswers).toEqual({ choice: answered });
      useShellStore.getState().applyCards([]);
      expect(useShellStore.getState().cardAnswers).toEqual({});
    });
  });

  it("returns a frame action refusal to the frame without changing the card", async () => {
    const ipc = request();
    const sent = useShellStore.getState().actOnCard("choice", "land", "frame");
    ipc.reject(new Error("This action is available only from the card controls."));
    await expect(sent).rejects.toThrow("available only from the card controls");
    expect(ipc.act).toHaveBeenCalledWith("choice", "land", "frame", undefined, gesture());
    expect(useShellStore.getState()).toMatchObject({
      cards: [ready],
      pendingCardActions: {},
      cardActionErrors: {},
    });
  });

  it("clears on a removal push and does not let a late receipt clear a reopened card's new request", async () => {
    const ipc = request();
    const first = useShellStore.getState().actOnCard("choice", "land");
    useShellStore.getState().applyCards([]);
    expect(useShellStore.getState().pendingCardActions).toEqual({});
    useShellStore.getState().applyCards([ready]);
    const second = useShellStore.getState().actOnCard("choice", "discard");
    ipc.replies[0]?.resolve({});
    await first;
    expect(useShellStore.getState().pendingCardActions.choice).toEqual({ actionId: "discard" });
    expect(useShellStore.getState().cards).toEqual([ready]);
    ipc.resolve();
    await second;
    expect(useShellStore.getState().pendingCardActions).toEqual({});
    expect(useShellStore.getState().cards).toEqual([]);
  });

  // Captain's INF-1160 revision: the ordinary failure choice reoffers the
  // outstanding action; its closing receipt must not remove that new offer.
  it("keeps a new offer pushed under the same card id before the old action's receipt", async () => {
    const ipc = request();
    const old = { ...ready, offerId: "offer-before" };
    useShellStore.setState({ cards: [old] });
    const sent = useShellStore.getState().actOnCard("choice", "land");
    const reopened = { ...ready, offerId: "offer-after" };
    useShellStore.getState().applyCards([reopened]);
    ipc.resolve();
    await sent;
    expect(useShellStore.getState().cards).toEqual([reopened]);
    expect(useShellStore.getState().pendingCardActions).toEqual({});
  });

  it("still applies shell effects after a removal push arrived before the receipt", async () => {
    const ipc = request();
    const first = useShellStore.getState().actOnCard("choice", "settings");
    useShellStore.getState().applyCards([]);
    ipc.resolve({ effect: { kind: "open", target: "settings" } });
    await first;
    expect(useShellStore.getState().view).toBe("settings");
  });
});

// INF-4439's review, from the captain's report that typed words must go
// through: an ended card's corner minus is Close, as its button is, so the
// words in its field go with it through the note's press rather than be lost.
describe("an ended card's corner", () => {
  const ended = card({
    id: "ended",
    status: "ready",
    body: "Ended.",
    noteDone: ENDED_CLOSE,
    corner: ENDED_CORNER,
    ended: { by: "crewmate", at: 1, line: endedLineWords("crewmate", undefined) },
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetShell();
  });

  it("presses Close with the field's words, and closes plainly with an empty field", async () => {
    const noteDone = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    vi.stubGlobal("window", { infinitary: { cards: { noteDone, close } } });
    useShellStore.setState({ cards: [ended], cardIndex: 0, records: [] });
    useShellStore.getState().setReplyDraft("ended", "Start it after the release");

    useShellStore.getState().closeCard("ended");
    await vi.waitFor(() => expect(noteDone).toHaveBeenCalledTimes(1));
    expect((noteDone.mock.calls[0] as unknown[] | undefined)?.[2]).toEqual({
      answers: [
        {
          name: ANYTHING_ELSE_ANSWER,
          values: [],
          changed: true,
          written: "Start it after the release",
        },
      ],
    });
    expect(close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(useShellStore.getState().replyDrafts.ended).toBeUndefined());

    useShellStore.getState().closeCard("ended");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(noteDone).toHaveBeenCalledTimes(1);
  });

  // INF-5608's review: an older home reads a press's value strictly and refuses notes, files or
  // pictures in it, so a view of one sends only the words and closes as before.
  it("against an older home, closes plainly and sends only the words, keeping the field's note", async () => {
    const noteDone = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const healthcheck = vi.fn(async () => ({ changes: [] as string[] }));
    vi.stubGlobal("window", { infinitary: { cards: { noteDone, close }, app: { healthcheck } } });
    useShellStore.setState({
      cards: [ended],
      cardIndex: 0,
      records: [],
      replyNotes: { ended: [NOTE] },
      thisMac: {
        role: "view",
        name: "MacBook Pro",
        address: "192.168.1.20",
        joinedAt: 0,
        contact: "in-reach",
        readOnly: null,
        heardAt: 0,
        caughtUp: 0,
      },
    });

    useShellStore.getState().closeCard("ended");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(noteDone).not.toHaveBeenCalled();

    useShellStore.getState().setReplyDraft("ended", "Start it after the release");
    await useShellStore.getState().pressNote("ended");
    expect((noteDone.mock.calls[0] as unknown[] | undefined)?.[2]).toEqual({
      answers: [
        {
          name: ANYTHING_ELSE_ANSWER,
          values: [],
          changed: true,
          written: "Start it after the release",
        },
      ],
    });
    expect(useShellStore.getState().replyNotes.ended).toEqual([NOTE]);
  });
});
