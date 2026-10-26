import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HERE } from "../../../shared/deviceNames";
import { ControllingTabView } from "../settings/ControllingTab";
import { joinedWhen } from "../settings/DevicesTab";
import { JoinAnotherMacView, type JoinAnotherMacViewProps } from "./JoinAnotherMac";
import { RemoteControlLineView } from "./RemoteControl";
import {
  browserNotHereWords,
  browserShownThereWords,
  changesOff,
  changesOffWords,
  clockTime,
  devicesNotHereWords,
  doneThereWords,
  firstMatePlace,
  JOIN_RUNS_WORK,
  joinRefusalWords,
  leftLine,
  namedNoticeWords,
  notSentWords,
  pillWords,
  settingsThereWords,
  topLine,
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
  it("names the Mac it controls, and says as of when it last heard it while it is out of reach", () => {
    expect(topLine(PRO)).toEqual({
      tone: "ok",
      lead: "Controlling your first mate on",
      name: "MacBook Pro",
      tail: null,
    });
    const away = renderToStaticMarkup(<RemoteControlLineView mac={AWAY} />);
    expect(away).toContain("MacBook Pro");
    expect(away).toContain("is out of reach · as of");
    expect(away).toContain(`data-as-of="">${clockTime(AWAY.heardAt ?? 0)}<`);
    expect(topLine({ ...PRO, readOnly: "newer-there" }).tail).toBe("· read only");
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

  it("says a card's button that opens Settings is done on the Mac it controls", () => {
    const words = settingsThereWords(PRO);
    expect(words).toBe("Do this on MacBook Pro. Its settings and sign-ins stay there.");
    expect(words).not.toMatch(NEVER);
  });

  // INF-1228, the captain's answer control=all: of a first mate started by a
  // command, a button that opens Settings opens it here; Devices and a
  // task's browser come later, and the button says so before the click.
  it("does a card's Settings button here for a first mate started by a command, and says what cannot be done yet", () => {
    const mini: ViewMac = { ...PRO, name: "Mac mini", startedByCommand: true };
    const open = (target: "subscriptions" | "projects" | "settings" | "devices") => ({
      effect: { kind: "open", target } as const,
    });
    for (const target of ["subscriptions", "projects", "settings"] as const) {
      expect(doneThereWords(mini, open(target))).toBeNull();
      expect(doneThereWords(PRO, open(target))).toBe(settingsThereWords(PRO));
    }
    expect(doneThereWords(mini, open("devices"))).toBe(
      "Mac mini's computers and phones cannot be changed from here yet.",
    );
    const browser = { effect: { kind: "open", target: "browser" } as const };
    expect(doneThereWords(mini, browser)).toBe(
      "This task's browser on Mac mini cannot be shown here yet.",
    );
    expect(browserShownThereWords(mini)).toEqual({
      lead: "This task's browser on Mac mini cannot be shown here yet.",
      detail: "A command started Infinitary on Mac mini, with no window to show it in.",
    });
    expect(firstMatePlace(mini)).toEqual({ this: "Mac mini", This: "Mac mini" });
    expect(firstMatePlace(PRO)).toEqual(HERE);
    expect(firstMatePlace(null)).toEqual(HERE);
    for (const words of [devicesNotHereWords(mini), browserNotHereWords(mini)])
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
  const render = (step: JoinAnotherMacViewProps["step"], value = "") =>
    renderToStaticMarkup(
      <JoinAnotherMacView
        step={step}
        value={value}
        onValue={noop}
        onOpen={noop}
        onContinue={noop}
        onConfirm={noop}
        onCancel={noop}
      />,
    );

  it("offers one chip under the provider chips, and an aside that takes only a pasted link", () => {
    const closed = render({ step: "closed" });
    expect(closed).toContain("Your first mate is on another computer");
    expect(closed).toContain("Paste its link");
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
