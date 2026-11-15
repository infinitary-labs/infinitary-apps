import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HERE } from "../../../shared/deviceNames";
import { joinAtRefusalWords } from "../../../shared/joinByAddress";
import { NEARBY_OFF, type NearbyMacsView } from "../../../shared/nearbyMacs";
import { remoteLoginWords } from "../../../shared/remoteLogin";
import { ControllingTabView } from "../settings/ControllingTab";
import { joinedWhen } from "../settings/devicesWords";
import { JoinAnotherMacView, type JoinAnotherMacViewProps } from "./JoinAnotherMac";
import { RemoteControlLineView } from "./RemoteControl";
import {
  browserNotHereWords,
  browserShownThereWords,
  browserWaitsForUpdate,
  catchUpOf,
  changesOff,
  changesOffWords,
  doneThereWords,
  firstMatePlace,
  googleUpdateThereWords,
  JOIN_RUNS_WORK,
  joinRefusalWords,
  leftLine,
  namedNoticeWords,
  notSentWords,
  pillWords,
  RETURN_PASTE_WORDS,
  sectionWaitsForUpdate,
  topLine,
  updateThereWords,
  type ViewMac,
} from "./viewWords";

/**
 * An app controlling Firstmate on another Mac, as the person reads it
 * (design skill components/devices/RemoteControl and JoinAnotherMac): the
 * top line, why changes are off, the words kept in the input, Leave, and the
 * join aside's steps. That Mac is named by its own name and never as a
 * home, server or host.
 */

const PRO: ViewMac = {
  role: "view",
  name: "MacBook Pro",
  address: "192.168.1.20",
  joinedAt: new Date(2026, 9, 3, 14, 6).getTime(),
  contact: "in-reach",
  readOnly: null,
  heardAt: null,
  caughtUp: 1,
};
const AWAY: ViewMac = {
  ...PRO,
  contact: "lost",
  heardAt: new Date(2026, 9, 3, 14, 32).getTime(),
};
const NOW = new Date(2026, 9, 3, 15, 20).getTime();
const noop = () => {};
const NEVER = /\b(home|server|host|offline|connection|socket|sync)\b/i;

describe("controlling another Mac", () => {
  // INF-4207 piece 2: live, catching up, or out of reach since a time that names the day.
  it("says live, catching up and how, or out of reach since a time that names the day", () => {
    expect(topLine(PRO, null, NOW)).toEqual({
      tone: "ok",
      lead: "Controlling your first mate on",
      name: "MacBook Pro",
      tail: "· live",
      when: null,
      freshness: "live",
    });
    expect(topLine(PRO, "replay", NOW)).toMatchObject({
      tone: "ring",
      tail: "· catching up on what was missed",
      freshness: "catching-up",
    });
    expect(topLine(PRO, "reload", NOW)).toMatchObject({
      tail: "· catching up, reading everything again",
      freshness: "catching-up",
    });
    expect(topLine({ ...PRO, contact: "reaching" }, null, NOW)).toMatchObject({
      tail: null,
      freshness: "reaching",
    });
    expect(topLine({ ...PRO, readOnly: "newer-there" }, null, NOW).tail).toBe("· read only");
    // Out of reach the same day says the time; another day names the day too.
    const today = topLine(AWAY, null, NOW);
    expect(today).toMatchObject({ tail: "is out of reach · since", freshness: "out-of-reach" });
    expect(today.when).not.toMatch(/Oct/);
    const yesterday = topLine(AWAY, null, new Date(2026, 9, 4, 9, 0).getTime());
    expect(yesterday.when).toContain("Oct 3");
    expect(yesterday.when).toContain(today.when);
    expect(topLine({ ...AWAY, heardAt: null }, null, NOW)).toMatchObject({
      tail: "is out of reach",
      when: null,
    });
    const away = renderToStaticMarkup(<RemoteControlLineView mac={AWAY} />);
    expect(away).toContain("MacBook Pro");
    expect(away).toContain('data-freshness="out-of-reach"');
    for (const tail of [today.tail, topLine(PRO, "replay").tail, topLine(PRO, "reload").tail])
      expect(tail).not.toMatch(NEVER);
  });

  it("is catching up while the window reads everything again, then while missed changes arrive", () => {
    // The window has read through the newest count: live.
    expect(catchUpOf(PRO, 1)).toBeNull();
    // A welcome that reloaded raised the count the window has not read through yet.
    expect(catchUpOf({ ...PRO, caughtUp: 2 }, 1)).toBe("reload");
    expect(catchUpOf({ ...PRO, replaying: true }, 1)).toBe("replay");
    // Out of reach is said over any catch-up.
    expect(catchUpOf({ ...AWAY, caughtUp: 2, replaying: true }, 1)).toBeNull();
  });

  it("turns changes off while the Mac is out of reach or too far apart, and says why", () => {
    expect(changesOff(null)).toBe(false);
    expect(changesOff({ role: "home", left: null })).toBe(false);
    expect(changesOff(PRO)).toBe(false);
    expect(changesOff(AWAY)).toBe(true);
    expect(changesOff({ ...PRO, contact: "reaching" })).toBe(true);
    expect(changesOff({ ...PRO, readOnly: "newer-there" })).toBe(true);
    expect(pillWords(PRO)).toBeNull();
    expect(pillWords(AWAY)).toBe(
      "Changes are off until MacBook Pro is back. It may be asleep, or on another network.",
    );
    expect(pillWords({ ...AWAY, contact: "closed" })).toBe(
      "Infinitary is closed on MacBook Pro. Changes are off until it opens again.",
    );
    expect(pillWords({ ...PRO, readOnly: "newer-there" })).toBe(
      "MacBook Pro has a newer Infinitary. Update Infinitary on this computer to make changes.",
    );
    // INF-4012 piece 2: a first mate there that still hears plain words says so, naming the side to update.
    expect(pillWords({ ...PRO, readOnly: "older-there", messagesWhileReading: true })).toBe(
      "MacBook Pro has an older Infinitary. Your first mate still hears your messages, and buttons come back once Infinitary there is updated.",
    );
    expect(pillWords({ ...PRO, readOnly: "newer-there", messagesWhileReading: true })).toBe(
      "MacBook Pro has a newer Infinitary. Your first mate still hears your messages, and buttons come back once Infinitary on this computer is updated.",
    );
    expect(changesOffWords(AWAY)).toBe("Changes are off until MacBook Pro is back");
    expect(notSentWords(AWAY)).toBe("Not sent. Your words stay here until MacBook Pro is back.");
    for (const words of [
      pillWords(AWAY),
      pillWords({ ...AWAY, contact: "closed" }),
      changesOffWords(AWAY),
      notSentWords(AWAY),
    ])
      expect(words).not.toMatch(NEVER);
  });

  it("says a file that cannot go to the Mac was not added, naming that Mac", () => {
    const words = "Only pictures and text files can go to MacBook Pro. Other files were not added.";
    expect(namedNoticeWords("file-other-mac", PRO)).toBe(words);
    expect(namedNoticeWords("away", AWAY)).toBe(notSentWords(AWAY));
    expect(namedNoticeWords("file-unreadable", PRO)).toBeNull();
    expect(words).not.toMatch(NEVER);
  });

  // The captain's answer on the review of one rule for every view: an older first mate gets
  // words before anything is asked of it, and a card that would need it is never sent.
  it("says the other computer needs an update when its first mate is too old", () => {
    const older: ViewMac = { ...PRO, needsUpdateThere: true };
    const words = "Update Infinitary on MacBook Pro to do this from here.";
    for (const target of ["subscriptions", "projects", "settings"] as const)
      expect(doneThereWords(older, { effect: { kind: "open", target } })).toBe(words);
    expect(
      doneThereWords(older, { effect: { kind: "host", op: "restore-account", arg: "a1" } }),
    ).toBe(words);
    // A task's saved sign-in needs nothing new of that first mate, so it is still sent.
    expect(
      doneThereWords(older, { effect: { kind: "open", target: "browser", savedSignIn: true } }),
    ).toBeNull();
    expect(doneThereWords(older, {})).toBeNull();
    expect(sectionWaitsForUpdate(older, {})).toBe(true);
    expect(sectionWaitsForUpdate(older, { onAnOlderFirstMate: true })).toBe(false);
    expect(sectionWaitsForUpdate(PRO, {})).toBe(false);
  });

  // INF-3454's plan, the captain's answer direction=catch-here: a first mate too old to take
  // Google's return from here is named, before any page opens, and so is the paste.
  it("names the first mate's computer to update for Google, and the address to paste", () => {
    expect(googleUpdateThereWords(PRO)).toContain("Update Infinitary on MacBook Pro");
    for (const words of [
      googleUpdateThereWords(PRO),
      RETURN_PASTE_WORDS.lead("Google"),
      RETURN_PASTE_WORDS.send(PRO),
      RETURN_PASTE_WORDS.refused,
    ])
      expect(words).not.toMatch(NEVER);
    expect(RETURN_PASTE_WORDS.send(PRO)).toContain("MacBook Pro");
  });

  // INF-1352's plan, the captain's answer one_rule=every-view: a button that opens Settings
  // opens it here on any view, Devices too (piece 2), unless the first mate there is too old to
  // answer it. Its piece 3 shows a task's browser on every view, unless the first mate there is
  // too old to send its pictures.
  it("does a card's Settings button here and says what cannot be done yet", () => {
    const open = (target: "subscriptions" | "projects" | "settings" | "devices") => ({
      effect: { kind: "open", target } as const,
    });
    for (const target of ["subscriptions", "projects", "settings", "devices"] as const)
      expect(doneThereWords(PRO, open(target))).toBeNull();
    // A first mate too old to answer a view's devices asks for its update instead.
    const noDevices: ViewMac = { ...PRO, devicesNeedUpdateThere: true };
    expect(doneThereWords(noDevices, open("devices"))).toBe(updateThereWords(noDevices));
    expect(doneThereWords(noDevices, open("settings"))).toBeNull();
    const browser = { effect: { kind: "open", target: "browser" } as const };
    expect(doneThereWords(PRO, browser)).toBeNull();
    const older: ViewMac = { ...PRO, browserNeedsUpdateThere: true };
    expect(doneThereWords(older, browser)).toBe(
      "Update Infinitary on MacBook Pro to show this task's browser here.",
    );
    expect(browserWaitsForUpdate(PRO)).toBe(false);
    expect(browserWaitsForUpdate(older)).toBe(true);
    expect(browserShownThereWords(older)).toEqual({
      lead: "Update Infinitary on MacBook Pro to show this task's browser here.",
      detail: "Until then, only a window on MacBook Pro can show it.",
    });
    expect(firstMatePlace(PRO)).toEqual({ this: "MacBook Pro", This: "MacBook Pro" });
    expect(firstMatePlace(null)).toEqual(HERE);
    for (const words of [updateThereWords(PRO), browserNotHereWords(PRO)])
      expect(words).not.toMatch(NEVER);
  });

  it("asks once in place before it leaves, with Stay first, and says what Leave does", () => {
    const row = renderToStaticMarkup(
      <ControllingTabView
        mac={PRO}
        now={NOW}
        asking={false}
        leaving={false}
        onAsk={noop}
        onLeave={noop}
      />,
    );
    expect(row).toContain("What you do here happens on MacBook Pro.");
    expect(row).toContain(`joined ${joinedWhen(PRO.joinedAt, NOW)} · 192.168.1.20`);
    expect(row).toContain('aria-label="Leave MacBook Pro"');
    const asking = renderToStaticMarkup(
      <ControllingTabView mac={AWAY} now={0} asking leaving={false} onAsk={noop} onLeave={noop} />,
    );
    expect(asking).toContain("Leave MacBook Pro? This computer stops controlling it.");
    expect(asking).toContain(
      "MacBook Pro is out of reach, so it lists this computer until you remove it there.",
    );
    expect(asking.indexOf("Stay")).toBeLessThan(asking.indexOf(">Leave<"));
    // A Mac that runs that Mac's work stops that too, once its work is there.
    const working = renderToStaticMarkup(
      <ControllingTabView
        mac={{ ...PRO, runsWork: true }}
        now={NOW}
        asking
        leaving={false}
        onAsk={noop}
        onLeave={noop}
      />,
    );
    expect(working).toContain(
      "Leave MacBook Pro? This computer stops controlling it and running its work.",
    );
    expect(working).toContain("Its unmerged work goes to MacBook Pro first.");
    expect(working).toContain("To control it again, make a new link there.");
  });

  it("says on its first launch which Mac it left, or that the Mac removed it", () => {
    expect(leftLine({ name: "MacBook Pro", reason: "left", at: 1 })).toBe(
      "This computer left MacBook Pro.",
    );
    expect(leftLine({ name: "MacBook Pro", reason: "removed", at: 1 })).toBe(
      "MacBook Pro removed this computer. Paste a new link to come back.",
    );
  });
});

describe("joining another Mac at first launch", () => {
  const render = (
    step: JoinAnotherMacViewProps["step"],
    value = "",
    typed: Partial<Pick<JoinAnotherMacViewProps, "address" | "port" | "account" | "nearby">> = {},
  ) =>
    renderToStaticMarkup(
      <JoinAnotherMacView
        step={step}
        value={value}
        onValue={noop}
        onOpen={noop}
        onContinue={noop}
        onConfirm={noop}
        onCancel={noop}
        address=""
        port=""
        account=""
        nearby={NEARBY_OFF}
        onAddress={noop}
        onPort={noop}
        onAccount={noop}
        onOpenAddress={noop}
        onContinueAddress={noop}
        onKeyYes={noop}
        onKeyCancel={noop}
        onPassword={noop}
        {...typed}
      />,
    );

  it("offers two chips under the provider chips, and an aside that takes only a pasted link", () => {
    const closed = render({ step: "closed" });
    expect(closed).toContain("Your first mate is on another computer");
    expect(closed).toContain("Paste its link");
    // INF-1827: Join by its address sits beside it, a button of its own, so Tab reaches both.
    expect(closed).toMatch(
      /<button type="button"[^>]*data-join-address-chip=""[^>]*>.*Join by its address/,
    );
    const paste = render({ step: "paste", notALink: false });
    expect(paste).toContain("Paste the link from Infinitary on your other computer");
    expect(paste).toContain('placeholder="infinitary://join?…"');
    // Continue waits for a link.
    expect(paste).toMatch(/<button[^>]*disabled=""[^>]*>Continue/);
    expect(render({ step: "paste", notALink: true }, "hello")).toContain(
      "That is not a link from Infinitary. Copy it again on your other computer.",
    );
  });

  it("confirms the address the link names before this Mac sends anything", () => {
    const confirm = render({ step: "confirm", address: "192.168.1.20", runsWork: false });
    expect(confirm).toContain(
      "Your first mate stays on the computer at <code>192.168.1.20</code>. Control it from here?",
    );
    expect(confirm).toContain(
      "This computer shows your first mate. Its cards, tasks and conversation stay on that computer.",
    );
    expect(confirm).toContain(
      "To keep your first mate on this computer instead, cancel and set it up here.",
    );
    expect(confirm).toContain("Control it from here");
    expect(confirm).not.toContain(JOIN_RUNS_WORK);
    // A link for a Mac says it can also run work there.
    expect(render({ step: "confirm", address: "192.168.1.20", runsWork: true })).toContain(
      JOIN_RUNS_WORK,
    );
    expect(
      render({ step: "confirm", address: "192.168.1.20", runsWork: false, alsoPrivate: true }),
    ).toContain("or on your private network");
    expect(render({ step: "reaching", address: "192.168.1.20" })).toContain(
      "Reaching the computer at <code>192.168.1.20</code>…",
    );
  });

  it("says why it did not join, naming the address where it is the thing itself", () => {
    const refused = render({ step: "refused", refused: "unreachable", address: "192.168.1.20" });
    expect(refused).toContain("This computer did not join");
    expect(refused).toContain("Could not reach <code>192.168.1.20</code>.");
    expect(refused).toContain("Paste another link");
    expect(joinRefusalWords("used", null)).toBe(
      "That link was used already. Make a new one on your other computer.",
    );
    expect(joinRefusalWords("expired", null)).toBe(
      "That link expired. A link lasts ten minutes; make a new one on your other computer.",
    );
    expect(joinRefusalWords("not-that-mac", "192.168.1.20")).toBe(
      "Something answered at 192.168.1.20, but not the computer that made this link. Nothing was sent to it.",
    );
  });
});

/**
 * INF-1827's accepted plan, with the captain's answers: Join by its address
 * at first launch - the account and computer, an optional port, Your account
 * above the computers nearby, the key line, the password once, and one
 * warning line per refusal with the address kept.
 */
describe("joining another computer by its address at first launch", () => {
  const STUDIO_NEARBY: NearbyMacsView = {
    state: "looking",
    user: "kun",
    macs: [
      { name: "Studio", at: "Studio.local" },
      { name: "Mac mini", at: "Mac-mini.local" },
    ],
  };
  const render = (
    step: JoinAnotherMacViewProps["step"],
    typed: Partial<Pick<JoinAnotherMacViewProps, "address" | "port" | "account" | "nearby">> = {},
  ) =>
    renderToStaticMarkup(
      <JoinAnotherMacView
        step={step}
        value=""
        onValue={noop}
        onOpen={noop}
        onContinue={noop}
        onConfirm={noop}
        onCancel={noop}
        address=""
        port=""
        account=""
        nearby={NEARBY_OFF}
        onAddress={noop}
        onPort={noop}
        onAccount={noop}
        onOpenAddress={noop}
        onContinueAddress={noop}
        onKeyYes={noop}
        onKeyCancel={noop}
        onPassword={noop}
        {...typed}
      />,
    );

  it("asks the account and computer and an optional port, with Your account above the computers nearby", () => {
    const html = render({ step: "address" }, { account: "kun", nearby: STUDIO_NEARBY });
    expect(html).toContain("Join by its address");
    expect(html).toContain('placeholder="kun@studio"');
    expect(html).toContain('aria-label="Port"');
    expect(html).toContain('placeholder="Port 22"');
    // Continue waits for an address.
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Continue/);
    // Your account sits above the list, and each row fills that account at the computer's name.
    expect(html.indexOf("Your account")).toBeLessThan(html.indexOf("Studio.local"));
    expect(html).toContain('value="kun"');
    expect(html).toContain(">kun@Studio.local<");
    expect(html).toContain(">kun@Mac-mini.local<");
    // With no account typed, a row fills the computer's name alone.
    expect(render({ step: "address" }, { nearby: STUDIO_NEARBY })).toContain(">Studio.local<");
    // While nothing is nearby there is no Your account field.
    expect(render({ step: "address" })).not.toContain("Your account");
  });

  it("says one warning line for a refusal, and keeps the address and the port", () => {
    const html = render(
      { step: "address", refused: "not-open", at: "ssh://kun@studio:2222" },
      { address: "kun@studio", port: "2222" },
    );
    expect(html).toContain('value="kun@studio"');
    expect(html).toContain('value="2222"');
    expect(html.match(/data-join-warn=""/g)).toHaveLength(1);
    expect(html).toContain(joinAtRefusalWords("not-open", "ssh://kun@studio:2222"));
  });

  it("asks once whether the key line is that computer, with Cancel focused", () => {
    const line = "ED25519 SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const html = render({ step: "key", address: "kun@studio", line });
    expect(html).toContain(remoteLoginWords.confirmQuestion("kun@studio")[0]);
    expect(html).toContain(line);
    // Cancel holds the focus, so Enter never says this is the computer.
    expect(html).toMatch(/<button[^>]*autofocus=""[^>]*>Cancel<\/button>/i);
    expect(html).not.toMatch(/autofocus=""[^>]*>This is the computer/i);
  });

  it("asks that account's password once, and says a wrong one over an empty field", () => {
    const question = { asks: "password" as const, address: "kun@studio", user: "kun" };
    const html = render({ step: "password", question });
    expect(html).toContain(remoteLoginWords.passwordQuestion("kun@studio")[0]);
    expect(html).toContain('type="password"');
    expect(html).toContain(remoteLoginWords.passwordField("kun").replaceAll("'", "&#x27;"));
    expect(html).not.toContain("data-join-warn");
    const wrong = render({ step: "password", question: { ...question, wrong: true } });
    expect(wrong).toContain(joinAtRefusalWords("password-wrong", "kun@studio"));
    expect(wrong).toContain('value=""');
  });

  it("asks the paste path's question for the computer it reached, and offers Try again when the join is refused", () => {
    const confirm = render({
      step: "confirm",
      address: "studio",
      runsWork: true,
      byAddress: true,
    });
    expect(confirm).toContain(
      "Your first mate stays on the computer at <code>studio</code>. Control it from here?",
    );
    expect(confirm).toContain(JOIN_RUNS_WORK);
    const refused = render({
      step: "refused",
      refused: "unreachable",
      address: "studio",
      byAddress: true,
    });
    expect(refused).toContain("Could not reach <code>studio</code>.");
    expect(refused).toContain(">Try again<");
    expect(refused).not.toContain("Paste another link");
  });
});
