import {
  BROWSER_RETURNED_OPENING,
  THREAD_BROWSER_HELD,
} from "../../../src/core/orchestrator/captainWakes";
import { BROWSER_SIGN_IN_STEP } from "../../../src/core/pi/cardTool";
import { PAGE_UNANSWERED_OPENING } from "../../../src/core/prompts/pageUnanswered";
import { HERE } from "../../../src/shared/deviceNames";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import {
  browser,
  firstSentence,
  knownRefOf,
  lookingAgain,
  MOCK_LEAVE_WAITING,
  refOf,
  toolAnswers,
} from "../browserScript";
import type { Scenario } from "../mockProvider";
import { answering, calledTool, providerMessages, toolCallCount } from "../providerRequest";

/**
 * A page that opens a release without a full load, a long passage, a time,
 * and a plain-text feed. The marker names the page; the script clicks the
 * release, tries the release link's ref from before the page moved, reads
 * the cut passage, reads the feed, photographs the whole page and reports
 * what the tools actually said.
 */
export const TASK_BROWSER_READING_MARKER = "read the release page at ";
export const MOCK_BROWSER_READING_REPORT_PREFIX = "The release page said";
export const MOCK_BROWSER_READING_PICTURE = "release-page";
/** What the reading report says when every check holds, in its order. */
export const MOCK_BROWSER_READING_PASSES = [
  "moved",
  "new title",
  "exact time",
  "title tooltip",
  "notes in full",
  "feed in full",
] as const;

function taskBrowserReadingStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/read the release page at (http:\/\/127\.0\.0\.1:\d+\/reading)/);
  if (!ask) return undefined;
  const url = ask[1] as string;
  const answers = toolAnswers(providerMessages(body));
  const missing = (what: string): ScriptedCall[] => [
    {
      name: "report",
      args: {
        text: `${MOCK_BROWSER_READING_REPORT_PREFIX} nothing with ${what}: ${(answers.at(-1) ?? "").slice(0, 500)}`,
      },
    },
  ];
  switch (answers.length) {
    case 0:
      return [browser("open", url)];
    case 1: {
      const ref = refOf(
        answers[0],
        "link",
        "Firstmate 3000 0.2.1-alpha.52 (private alpha, alpha channel)",
      );
      return ref ? [browser("click", `@${ref}`)] : missing("the release link");
    }
    case 2: {
      // The release link's ref from before the page moved, used where a
      // stale ref would do least: a scroll.
      const ref = refOf(
        answers[0],
        "link",
        "Firstmate 3000 0.2.1-alpha.52 (private alpha, alpha channel)",
      );
      return ref ? [browser("scroll", `@${ref}`)] : missing("the release link");
    }
    case 3: {
      const ref = refOf(answers[1], "text", "");
      return ref ? [browser("snapshot", `@${ref}`)] : missing("a cut passage");
    }
    case 4:
      return [browser("screenshot", MOCK_BROWSER_READING_PICTURE, "--full-page")];
    case 5:
      return [browser("open", `${url}/feed`)];
    case 6: {
      const ref = refOf(answers[5], "text", "");
      return ref ? [browser("snapshot", `@${ref}`)] : missing("the feed passage");
    }
    case 7:
      return [browser("stop")];
    case 8: {
      const listed = answers[0] ?? "";
      const click = answers[1] ?? "";
      const stale = answers[2] ?? "";
      const notes = answers[3] ?? "";
      const feed = answers[6] ?? "";
      const [movedOk, titleOk, timeOk, tipOk, tailOk, atomOk] = MOCK_BROWSER_READING_PASSES;
      const moved = click.includes("/reading/one") ? movedOk : "stayed";
      const title = click.includes('heading "Firstmate 3000 0.2.1-alpha.52"')
        ? titleOk
        : "old title";
      const time = listed.includes("2026-10-08T21:52:52Z") ? timeOk : "no time";
      const tip = listed.includes("Oct 8, 2026, 2:52 PM PDT") ? tipOk : "no tooltip";
      const tail = notes.includes("anything stays secret in the notes") ? tailOk : "notes cut";
      const atom = feed.includes("feed ends with the atom tail") ? atomOk : "feed cut";
      return [
        {
          name: "report",
          args: {
            text: `${MOCK_BROWSER_READING_REPORT_PREFIX} ${moved}, ${title}, ${time}, ${tip}, ${tail}, ${atom}. The old ref: "${firstSentence(stale)}"`,
          },
        },
      ];
    }
    default:
      return undefined;
  }
}

/**
 * A page too long for one answer (docs/task-browser.md, "Reading a long
 * page"). The marker names the page; the script opens it, finds words in
 * its last section, reads on from the line the first answer's next lines
 * name, scrolls down, photographs the visible page there, and reports what
 * each answer actually showed.
 */
export const TASK_BROWSER_LONG_MARKER = "read the long changelog at ";
export const MOCK_BROWSER_LONG_REPORT_PREFIX = "The long changelog said";
/** Words only the changelog's last section holds. */
export const TASK_BROWSER_LONG_LAST_WORDS = "the last release ends here";
/** The picture of the visible page taken after the scroll (INF-2375). */
export const MOCK_BROWSER_LONG_PICTURE = "scrolled-changelog";
/** What the long changelog report says when every check holds, in its order. */
export const MOCK_BROWSER_LONG_PASSES = [
  "a map",
  "folded repeats",
  "found the end",
  "read on",
  "scrolled past the top",
] as const;

function firstShownLine(answer: string | undefined): number | undefined {
  const line = answer?.match(/^outline: lines (\d+)-\d+ of \d+/m)?.[1];
  return line === undefined ? undefined : Number(line);
}

function taskBrowserLongStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/read the long changelog at (http:\/\/127\.0\.0\.1:\d+\/long)/);
  if (!ask) return undefined;
  const url = ask[1] as string;
  const answers = toolAnswers(providerMessages(body));
  const readOn = answers[0]?.match(/`infinitary-browser-axi snapshot --from (\d+)`/)?.[1];
  switch (answers.length) {
    case 0:
      return [browser("open", url)];
    case 1:
      return [browser("snapshot", "--find", TASK_BROWSER_LONG_LAST_WORDS)];
    case 2:
      return [browser("snapshot", "--from", Number(readOn ?? 0))];
    case 3:
      return [browser("scroll", "down")];
    case 4:
      return [browser("screenshot", MOCK_BROWSER_LONG_PICTURE)];
    case 5:
      return [browser("stop")];
    case 6: {
      const [opened = "", found = "", read = "", scrolled = ""] = answers;
      const [mapOk, foldsOk, endOk, readOk, scrollOk] = MOCK_BROWSER_LONG_PASSES;
      const facts = [
        /^map\[\d+\]:$/m.test(opened) && opened.includes('region "Release 40"') ? mapOk : "no map",
        opened.includes("(same as line ") ? foldsOk : "no folds",
        (firstShownLine(found) ?? 1) > 1 &&
        found.includes(`text "And ${TASK_BROWSER_LONG_LAST_WORDS}."`)
          ? endOk
          : "did not find the end",
        readOn !== undefined && firstShownLine(read) === Number(readOn)
          ? readOk
          : "did not read on",
        (firstShownLine(scrolled) ?? 1) > 1 && scrolled.includes(", those on screen")
          ? scrollOk
          : "scrolled to the same top",
      ];
      const sizes = answers
        .slice(0, 4)
        .map((answer) => answer.length)
        .join(", ");
      return [
        {
          name: "report",
          args: {
            text: `${MOCK_BROWSER_LONG_REPORT_PREFIX} ${facts.join(", ")}. Characters per answer: ${sizes}.`,
          },
        },
      ];
    }
    default:
      return undefined;
  }
}

/**
 * A page opens a second page (docs/task-browser.md, "A second page"). A
 * brief carrying this marker, a shop and a bank this Mac serves, and a
 * site whose certificate does not verify ("pay at the shop page at
 * http://127.0.0.1:A/ with the bank at http://localhost:B/ after
 * https://localhost:C/") drives the task's own browser the way a crewmate
 * would: it opens the untrusted site first and reads the refusal, opens the
 * bank (so the shop's page may reach it), then the shop, and clicks Pay.
 * The shop opens the bank's check as a second page; the crewmate waits on
 * it for the bank to say "Ready to approve" - which it does once the spec
 * tells its server so, keeping the turn and both pages up meanwhile -
 * clicks Approve, waits for the shop to say it was paid once the check has
 * closed itself, and reports what each answer said, read off the tool
 * results, never assumed.
 */
export const TASK_BROWSER_PAGES_MARKER = "pay at the shop page at ";
export const MOCK_PAGES_REPORT_PREFIX = "The shop and its bank said";
/** The words the shop report puts before what it read of the bank's check and the shop. */
export const MOCK_PAGES_SAID = { check: "The check:", shop: "The shop:" } as const;
/** The words the bank's check shows once the spec lets the crewmate approve. */
export const TASK_BROWSER_APPROVE_WORDS = "Ready to approve";

function taskBrowserPagesStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(
    /pay at the shop page at (http:\/\/127\.0\.0\.1:\d+\/) with the bank at (http:\/\/localhost:\d+\/) after (https:\/\/localhost:\d+\/)/,
  );
  if (!ask) return undefined;
  const [, shop, bank, untrusted] = ask as unknown as [string, string, string, string];
  const answers = toolAnswers(providerMessages(body));
  const last = answers.at(-1) ?? "";
  const report = (text: string): ScriptedCall[] => [
    { name: "report", args: { text: `${MOCK_PAGES_REPORT_PREFIX} ${text}` } },
  ];
  switch (answers.length) {
    case 0:
      return [browser("open", untrusted)];
    case 1:
      return [browser("open", bank)];
    case 2:
      return [browser("open", shop)];
    case 3: {
      const ref = refOf(last, "button", "Pay");
      return ref
        ? [browser("click", `@${ref}`)]
        : report(`nothing with a Pay button: ${last.slice(0, 400)}`);
    }
    default:
      break;
  }
  // Waiting on the bank's check until it is ready: each wait is up to ten seconds of turn.
  const approved = answers.some((text) => text.includes('did: Clicked button "Approve"'));
  if (!approved) {
    if (!last.includes(`Found "${TASK_BROWSER_APPROVE_WORDS}"`)) {
      return [browser("wait", TASK_BROWSER_APPROVE_WORDS)];
    }
    const ref = refOf(last, "button", "Approve");
    return ref
      ? [browser("click", `@${ref}`)]
      : report(`nothing with an Approve button: ${last.slice(0, 400)}`);
  }
  if (!last.includes('Found "Paid with"') && !last.includes("Waited")) {
    return [browser("wait", "Paid with")];
  }
  const all = answers.join("\n");
  const opened = all.match(/The page opened a second page[^.]*\./)?.[0] ?? "no second page";
  const closed = all.match(/Page 2 \([^)]+\) closed itself[^.]*\./)?.[0] ?? "it never closed";
  const paid = last.match(/text "(Paid[^"]*)"/)?.[1];
  return report(
    `"${firstSentence(answers[0])}" Then: "${opened}" ${MOCK_PAGES_SAID.check} "${answers.some((text) => /^\s*page: 2 of 2$/m.test(text)) ? "page 2 of 2" : "one page"}". After Approve: "${closed}" ${MOCK_PAGES_SAID.shop} "${paid}".`,
  );
}

/**
 * The captain watches a task's browser (docs/task-browser.md, "The view").
 * A brief carrying this marker, a page this Mac serves and a name ("watch
 * the sign-up page at http://127.0.0.1:PORT/ as Sam") opens the task's
 * browser there and types the name, then keeps its turn running - the
 * crewmate driving - by waiting for the page to say "Ready to send", which
 * it does once the spec tells the server so. Then it clicks Send and
 * reports what the page said, leaving its browser open: nobody drives it.
 */
export const TASK_BROWSER_WATCH_MARKER = "watch the sign-up page at ";
export const MOCK_BROWSER_WATCH_REPORT_PREFIX = "The watched sign-up page said";
/** The words the watched page shows once the spec lets the crewmate go on. */
export const TASK_BROWSER_READY_WORDS = "Ready to send";

function taskBrowserWatchStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/watch the sign-up page at (http:\/\/127\.0\.0\.1:\d+\/) as (\w+)/);
  if (!ask) return undefined;
  const [, url, name] = ask as unknown as [string, string, string];
  const messages = providerMessages(body);
  const exchange = browserCardExchange(body, messages, 0);
  if (exchange) return exchange.length ? exchange : undefined;
  const answers = toolAnswers(messages);
  const last = answers.at(-1) ?? "";
  if (answers.length === 0) return [browser("open", url)];
  if (answers.length === 1) {
    const ref = refOf(last, "textbox", "Name");
    return ref
      ? [browser("fill", `@${ref}`, name)]
      : [{ name: "report", args: { text: `${MOCK_BROWSER_WATCH_REPORT_PREFIX} no Name field.` } }];
  }
  // Driving until the page is ready: each wait is up to ten seconds of turn.
  if (!last.includes(`Found "${TASK_BROWSER_READY_WORDS}"`) && !last.includes("Clicked")) {
    return [browser("wait", TASK_BROWSER_READY_WORDS)];
  }
  if (!last.includes("Clicked")) {
    const ref = knownRefOf(answers, "button", "Send");
    return ref
      ? [browser("click", `@${ref}`)]
      : [{ name: "report", args: { text: `${MOCK_BROWSER_WATCH_REPORT_PREFIX} no Send button.` } }];
  }
  const thanks = last.match(/text "(Thanks, [^"]+)"/)?.[1];
  return [
    {
      name: "report",
      args: { text: `${MOCK_BROWSER_WATCH_REPORT_PREFIX} "${thanks}", and left its browser open.` },
    },
  ];
}

/**
 * A card that opens its task's browser (docs/task-browser.md, "From a
 * card"). A brief carrying this marker, a page this Mac serves and a name
 * ("show the sign-up page at http://127.0.0.1:PORT/ as Sam") opens the
 * task's browser there, types the name and clicks Send by the outline's
 * refs, then emits a decision whose browser button reads "Try it" and
 * reports, leaving its browser open for the captain to try. Asked a
 * question under that card, it answers with a new card.
 */
export const TASK_BROWSER_CARD_MARKER = "show the sign-up page at ";
export const MOCK_BROWSER_CARD_TITLE = "The sign-up page thanks the name after Send";
export const MOCK_BROWSER_BUTTON = "Try it";
export const MOCK_BROWSER_CARD_REPORT = "I left the sign-up page open for the captain to try.";
/** The sign-up card's default choice. */
export const MOCK_BROWSER_CARD_DEFAULT = "Looks right";
/** The sign-up card's checklist, what the captain reads beside the page. */
export const MOCK_BROWSER_CARD_STEPS = [
  "Type a name into Name.",
  "Press Send.",
  "Check that the thanks line names you.",
] as const;
/**
 * The captain's question from beside the page (INF-4578's direction A,
 * piece 3): the crewmate answers in the original thread, then raises a
 * new card only after the captain reads the answer and asks for the choice.
 */
export const MOCK_BROWSER_CARD_QUESTION = "Should the thanks line name the page too?";
export const MOCK_BROWSER_CARD_ANSWER = "Yes, it can. I can put that choice on a new card.";
export const MOCK_BROWSER_RAISE_CARD = "Please put that choice on a new card.";
export const MOCK_BROWSER_RAISED_TITLE = "The thanks line can name the page";
export const MOCK_BROWSER_RAISED_STEP = "Press Send again and read the thanks line.";
export const MOCK_BROWSER_RAISED_DEFAULT = "Name the page";
/**
 * What it reports when woken because nothing answers at its page
 * (docs/task-browser.md, "When nothing answers"): the journey brings the
 * site back itself, standing in for the crewmate starting its build.
 */
export const MOCK_UNANSWERED_REPORT = "Nothing answered at the sign-up page, so I start it again.";

/** Separate captain messages put the answer and replacement in a deliberate order. */
function browserCardExchange(
  body: string,
  messages: ReturnType<typeof providerMessages>,
  priorCards: number,
): ScriptedCall[] | undefined {
  const asked = messages.findLast(
    (message) => message.role === "user" && message.text.includes(MOCK_BROWSER_CARD_QUESTION),
  );
  if (!asked) return undefined;
  const followUp = messages.findLast(
    (message) => message.role === "user" && message.text.includes(MOCK_BROWSER_RAISE_CARD),
  );
  const cardId = (message: string) =>
    message.match(/Card "[^"]*" \((card-[\w-]+)\)/)?.[1] ?? "missing";
  if (followUp) {
    if (toolCallCount(body, "emit_card") > priorCards) return [];
    return [
      {
        name: "reply",
        args: {
          card_id: cardId(followUp.text),
          text: "I’ll put that choice on a new card.",
          ...answering(followUp.text),
        },
      },
      {
        name: "emit_card",
        args: {
          id: "name-the-page",
          title: MOCK_BROWSER_RAISED_TITLE,
          body:
            "<p>I can make the thanks line say which page thanked you.</p>" +
            `<ol><li>${MOCK_BROWSER_RAISED_STEP}</li><li>Choose below whether it should name the page.</li></ol>`,
          actions: [
            { id: "keep", label: "Keep it as it is" },
            { id: "name-page", label: MOCK_BROWSER_RAISED_DEFAULT, default: true },
          ],
        },
      },
    ];
  }
  if (calledTool(body, "reply")) return [];
  return [
    {
      name: "reply",
      args: {
        card_id: cardId(asked.text),
        text: MOCK_BROWSER_CARD_ANSWER,
        ...answering(asked.text),
      },
    },
  ];
}

/**
 * A crewmate asks the captain to sign in (docs/task-browser.md, "Asking for
 * help"). A brief carrying this marker and a page this Mac serves ("sign in
 * to the account page at http://127.0.0.1:PORT/") opens the task's browser
 * there, emits an ordinary decision that asks the captain to take the
 * browser over - the site, why, what it does after - then tries to read the
 * page once more and reports what its browser answered. Woken by the
 * captain's Return control, it clicks Sign in by its ref from before the
 * handoff, takes a fresh look - waiting for the page to say "Ready to go
 * on", which it does once the spec tells the server so - and reports what
 * each answer said, read off the tool results, never assumed.
 */
export const TASK_BROWSER_HANDOFF_MARKER = "sign in to the account page at ";
export const MOCK_HANDOFF_CARD_TITLE = "Sign in to the account page to continue";
/** Why the crewmate asks the captain to take its browser: its card's words and its request's reason. */
export const MOCK_HANDOFF_REASON = "The account page needs your sign-in";
export const MOCK_HANDOFF_ACTION = BROWSER_SIGN_IN_STEP;
export const MOCK_HANDOFF_ASKED_REPORT = "I asked the captain to sign in.";
export const MOCK_HANDOFF_RETURNED_REPORT = "The captain returned my browser.";
export const TASK_BROWSER_HANDOFF_READY_WORDS = "Ready to go on";
/** The words the handoff and take-over reports put before each answer they quote. */
export const MOCK_BROWSER_SAID = {
  before: "My browser then said:",
  freshLook: "The fresh look said",
  page: "the page said",
  keptNothing: "nothing from the captain's time",
  noReason: "A picture without a reason:",
  withReason: "With one:",
  commandBefore: "The command before it answered",
  refusal: "Then my browser said",
} as const;
/** The picture it takes of the signed-in page, once with a reason (docs/task-browser.md, "A signed-in page"). */
export const MOCK_SIGNED_IN_PICTURE = "signed-in-account";
export const MOCK_SIGNED_IN_PICTURE_REASON = "the task needs to show which account is signed in";

/**
 * The crewmate's answers, in order, to the captain's lines under its docked
 * request while he holds its browser: it answers each from what it knows,
 * since it cannot see the page (INF-4578).
 */
export const MOCK_HANDOFF_THREAD_ANSWERS = [
  "Pick the second workspace, the one named Team: the task's account lives there.",
  "Keep the Monthly plan; the task changes nothing about billing.",
  "Leave the Note field empty; nothing in the task needs it.",
] as const;
/**
 * A line whose answer the stand-in keeps back until the spec lets it go
 * (`releaseThreadAnswer`), so the reply waits on the crewmate while the
 * captain puts the view aside.
 */
export const MOCK_HANDOFF_HELD_QUESTION = "Should I fill in the Note field too?";

/** Whether the newest line beside the held page is the one whose answer waits. */
function answerWaits(body: string): boolean {
  const held = providerMessages(body).filter(
    (message) => message.role === "user" && message.text.includes(THREAD_BROWSER_HELD),
  );
  return (
    held.length > toolCallCount(body, "reply") &&
    (held.at(-1)?.text.includes(MOCK_HANDOFF_HELD_QUESTION) ?? false)
  );
}

/** Its answer to the newest line the captain wrote beside the held page, once per line. */
function heldThreadAnswer(
  body: string,
  messages: ReturnType<typeof providerMessages>,
): ScriptedCall[] | undefined {
  const held = messages.filter(
    (message) => message.role === "user" && message.text.includes(THREAD_BROWSER_HELD),
  );
  const answered = toolCallCount(body, "reply");
  if (held.length <= answered) return undefined;
  const steer = held.at(-1)?.text ?? "";
  const cardId = steer.match(/Card "[^"]*" \((card-[\w-]+)\)/)?.[1] ?? "missing";
  const text = MOCK_HANDOFF_THREAD_ANSWERS[
    Math.min(answered, MOCK_HANDOFF_THREAD_ANSWERS.length - 1)
  ] as string;
  return [{ name: "reply", args: { card_id: cardId, text, ...answering(steer) } }];
}

function taskBrowserHandoffStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/sign in to the account page at (http:\/\/127\.0\.0\.1:\d+\/)/);
  if (!ask) return undefined;
  const url = ask[1] as string;
  const messages = providerMessages(body);
  const reply = heldThreadAnswer(body, messages);
  if (reply) return reply;
  const wake = messages.findIndex(
    (message) => message.role === "user" && message.text.includes(BROWSER_RETURNED_OPENING),
  );
  const answers = (from: number) => toolAnswers(messages, from);
  if (wake === -1) {
    if (calledTool(body, "report")) return undefined;
    const before = answers(0);
    switch (before.length) {
      case 0:
        return [browser("open", url)];
      case 1:
        return [
          {
            name: "emit_card",
            args: {
              id: "sign-in-request",
              title: MOCK_HANDOFF_CARD_TITLE,
              body: `<p>${MOCK_HANDOFF_REASON} before I can go on, so I paused the browser on its sign-in page.</p><p>While you have control I cannot see the page, and your typing is not recorded.</p>`,
              browser_handoff: {
                site: new URL(url).host,
                reason: MOCK_HANDOFF_REASON,
                after: "read the account page and report what it says",
              },
              actions: [
                { id: "leave", label: MOCK_LEAVE_WAITING },
                {
                  id: "sign-in",
                  label: MOCK_HANDOFF_ACTION,
                  default: true,
                  effect: { kind: "open", target: "browser" },
                },
              ],
            },
          },
        ];
      case 2:
        return [browser("snapshot")];
      case 3:
        return [
          {
            name: "report",
            args: {
              text: `${MOCK_HANDOFF_ASKED_REPORT} ${MOCK_BROWSER_SAID.before} "${firstSentence(before[2])}"`,
            },
          },
        ];
      default:
        return undefined;
    }
  }
  const after = answers(wake);
  // Its report's own answer: this turn has said what it found.
  if (after.some((text) => text.startsWith("Reported."))) return undefined;
  if (after.length === 0) {
    // The Sign in button's ref from before the handoff.
    const ref = refOf(answers(0)[0], "button", "Sign in") ?? "g1:e1";
    return [browser("click", `@${ref}`)];
  }
  const looked = after.findIndex(
    (text, index) =>
      index > 0 &&
      (text.includes(`Found "${TASK_BROWSER_HANDOFF_READY_WORDS}"`) || text.includes("Waited")),
  );
  if (looked === -1) {
    return [browser("wait", TASK_BROWSER_HANDOFF_READY_WORDS)];
  }
  // The page may show the captain's account now: a picture only with a reason.
  const refused = after.find((text) =>
    text.includes("a picture is taken only when the task needs one"),
  );
  const saved = after.find((text) => /^did: Saved /m.test(text));
  if (!refused) return [browser("screenshot", MOCK_SIGNED_IN_PICTURE)];
  if (!saved) {
    return [
      browser("screenshot", MOCK_SIGNED_IN_PICTURE, "--reason", MOCK_SIGNED_IN_PICTURE_REASON),
    ];
  }
  const look = after.slice(1, looked + 1).join("\n");
  const state = look.match(/text "((?:Not signed in|Signed in as [^"]+))"/)?.[1];
  const kept = ["private sign-in note", "tracker.example"].filter((word) => look.includes(word));
  return [
    {
      name: "report",
      args: {
        text: `${MOCK_HANDOFF_RETURNED_REPORT} The old ref: "${firstSentence(after[0])}" ${MOCK_BROWSER_SAID.freshLook} "${firstSentence(after[1])}" and ${MOCK_BROWSER_SAID.page} "${state}". It kept ${kept.length ? kept.join(" and ") : MOCK_BROWSER_SAID.keptNothing}. ${MOCK_BROWSER_SAID.noReason} "${refused.split("\n")[0]}" ${MOCK_BROWSER_SAID.withReason} "${saved.match(/^did: (.*?) \(/m)?.[1]}".`,
      },
    },
  ];
}

/**
 * A sign-in that returns to a program on this computer (docs/task-browser.md,
 * "Where a page may go"). A brief carrying this marker and an account page
 * this Mac serves ("sign in for a program at http://127.0.0.1:PORT/") opens
 * the task's browser there and asks the captain to sign in, never opening
 * the program's own address first. Woken by Return control, it takes its
 * fresh look, opens the sign-in page again, and reports what the program's
 * page said, read off that look, never assumed.
 */
export const TASK_BROWSER_LOCAL_RETURN_MARKER = "sign in for a program at ";
export const MOCK_LOCAL_RETURN_CARD_TITLE = "Sign in so the program can finish its sign-in";
export const MOCK_LOCAL_RETURN_ASKED_REPORT = "I asked the captain to sign in for the program.";
export const MOCK_LOCAL_RETURN_REPORT = "The sign-in came back to the program.";
/** The words the report puts before each answer it quotes. */
export const MOCK_LOCAL_RETURN_SAID = "The program's page said";

function taskBrowserLocalReturnStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/sign in for a program at (http:\/\/127\.0\.0\.1:\d+\/)/);
  if (!ask) return undefined;
  const url = ask[1] as string;
  const messages = providerMessages(body);
  const wake = messages.findIndex(
    (message) => message.role === "user" && message.text.includes(BROWSER_RETURNED_OPENING),
  );
  if (wake === -1) {
    if (calledTool(body, "report")) return undefined;
    switch (toolAnswers(messages).length) {
      case 0:
        return [browser("open", url)];
      case 1:
        return [
          {
            name: "emit_card",
            args: {
              id: "program-sign-in",
              title: MOCK_LOCAL_RETURN_CARD_TITLE,
              body: "<p>The program needs your sign-in on this page, which then returns to it.</p>",
              browser_handoff: {
                site: new URL(url).host,
                reason: "The program needs your sign-in",
                after: "check that the program finished its sign-in",
              },
              actions: [
                { id: "leave", label: MOCK_LEAVE_WAITING },
                {
                  id: "sign-in",
                  label: BROWSER_SIGN_IN_STEP,
                  default: true,
                  effect: { kind: "open", target: "browser" },
                },
              ],
            },
          },
        ];
      default:
        return [{ name: "report", args: { text: MOCK_LOCAL_RETURN_ASKED_REPORT } }];
    }
  }
  const after = toolAnswers(messages, wake);
  if (after.some((text) => text.startsWith("Reported."))) return undefined;
  const look = after[0];
  if (look === undefined) return [browser()];
  if (after.length === 1) return [browser("open", url)];
  const said = look.match(/Program [a-z ]+/)?.[0] ?? look.split("\n").slice(0, 3).join(" | ");
  return [
    {
      name: "report",
      args: { text: `${MOCK_LOCAL_RETURN_REPORT} ${MOCK_LOCAL_RETURN_SAID} "${said}".` },
    },
  ];
}

/**
 * A sign-in kept on this Mac reaches a later task (docs/task-browser.md,
 * "Signed-in sites"). A brief carrying this marker and a club page this Mac
 * serves ("use the club page at http://127.0.0.1:PORT/ as ...") opens the
 * task's browser there and asks the captain to sign in on an ordinary
 * decision marked as a sign-in (`browser_sign_in`) - the host may add the
 * kept sign-in beside its own action - and reports that it asked. Woken, by
 * Return control or by the kept sign-in, it opens the page again, so the
 * club's server sees its sign-in, and reports the wake's first sentence and
 * what the page said, read off the tool results, never assumed. When a kept
 * sign-in left the page signed out, it asks again on a card that says so
 * (`saved_failed`, INF-1849) and reports what that card's answer said.
 */
export const TASK_BROWSER_SAVED_MARKER = "use the club page at ";
export const MOCK_SAVED_CARD_TITLE = "Sign in to the club page to continue";
export const MOCK_SAVED_ACTION = BROWSER_SIGN_IN_STEP;
export const MOCK_SAVED_ASKED_REPORT = "I asked the captain to sign in to the club page.";
export const MOCK_SAVED_REPORT_PREFIX = "The club page said";
/** The words the saved sign-in report puts before the wake it quotes. */
export const MOCK_SAVED_WAKE_SAID = "The wake said";
export const MOCK_SAVED_FAILED_CARD_TITLE = "Sign in to the club page again";
export const MOCK_SAVED_FAILED_REPORT = "The saved sign-in left the club page signed out.";
const SAVED_WAKES = [
  BROWSER_RETURNED_OPENING,
  `The captain let this task use the sign-in kept on ${HERE.this}`,
];

function taskBrowserSavedStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/use the club page at (http:\/\/127\.0\.0\.1:\d+\/)/);
  if (!ask) return undefined;
  const url = ask[1] as string;
  const messages = providerMessages(body);
  const wake = messages.findIndex(
    (message) =>
      message.role === "user" && SAVED_WAKES.some((words) => message.text.includes(words)),
  );
  const answers = (from: number) => toolAnswers(messages, from);
  if (wake === -1) {
    if (calledTool(body, "report")) return undefined;
    const before = answers(0);
    if (before.length === 0) return [browser("open", url)];
    if (before.length === 1) {
      return [
        {
          name: "emit_card",
          args: {
            id: "club-sign-in",
            title: MOCK_SAVED_CARD_TITLE,
            body: "<p>The club page needs your sign-in before I can read your membership, so I paused the browser on it.</p><p>While you have control I cannot see the page, and your typing is not recorded.</p>",
            browser_handoff: {
              site: new URL(url).host,
              reason: "The club page needs your sign-in",
              after: "read the club page and report what it says",
            },
            browser_sign_in: true,
            actions: [
              { id: "leave", label: MOCK_LEAVE_WAITING },
              {
                id: "sign-in",
                label: MOCK_SAVED_ACTION,
                default: true,
                effect: { kind: "open", target: "browser" },
              },
            ],
          },
        },
      ];
    }
    // A refused card is reported as it was refused, so a spec reads why.
    const refused = before[1]?.startsWith("Card refused") ? ` ${before[1]}` : "";
    return [{ name: "report", args: { text: `${MOCK_SAVED_ASKED_REPORT}${refused}` } }];
  }
  const after = answers(wake);
  if (after.some((text) => text.startsWith("Reported."))) return undefined;
  if (after.length === 0) return [browser("open", url)];
  const state = after[0]?.match(/text "((?:Not signed in|Signed in as [^"]+))"/)?.[1];
  const woken = firstSentence(messages[wake]?.text);
  if (state === "Not signed in" && messages[wake]?.text.includes(SAVED_WAKES[1] as string)) {
    if (after.length === 1) {
      return [
        {
          name: "emit_card",
          args: {
            id: "club-sign-in-again",
            title: MOCK_SAVED_FAILED_CARD_TITLE,
            body: "<p>The club page still asks for a sign-in after your saved one, so I paused the browser on it again.</p><p>While you have control I cannot see the page, and your typing is not recorded.</p>",
            browser_handoff: {
              site: new URL(url).host,
              reason: "The saved sign-in did not sign the club page in",
              after: "read the club page and report what it says",
              saved_failed: true,
            },
            browser_sign_in: true,
            actions: [
              { id: "leave", label: MOCK_LEAVE_WAITING },
              {
                id: "sign-in",
                label: MOCK_SAVED_ACTION,
                default: true,
                effect: { kind: "open", target: "browser" },
              },
            ],
          },
        },
      ];
    }
    return [
      {
        name: "report",
        args: { text: `${MOCK_SAVED_FAILED_REPORT} The card: "${after[1]?.split("\n")[0]}"` },
      },
    ];
  }
  return [
    {
      name: "report",
      args: { text: `${MOCK_SAVED_REPORT_PREFIX} "${state}". ${MOCK_SAVED_WAKE_SAID} "${woken}"` },
    },
  ];
}

function taskBrowserCardStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/show the sign-up page at (http:\/\/127\.0\.0\.1:\d+\/) as (\w+)/);
  if (!ask) return undefined;
  const [, url, name] = ask as unknown as [string, string, string];
  const messages = providerMessages(body);
  const woken = messages.findLastIndex(
    (message) => message.role === "user" && message.text.includes(PAGE_UNANSWERED_OPENING),
  );
  if (woken !== -1) {
    return toolAnswers(messages, woken).length === 0
      ? [{ name: "report", args: { text: MOCK_UNANSWERED_REPORT } }]
      : undefined;
  }
  const exchange = browserCardExchange(body, messages, 1);
  if (exchange) return exchange.length ? exchange : undefined;
  const answers = toolAnswers(messages);
  const last = answers.at(-1) ?? "";
  const missing = (what: string): ScriptedCall[] => [
    { name: "report", args: { text: `The sign-up page has no ${what}: ${last.slice(0, 400)}` } },
  ];
  switch (answers.length) {
    case 0:
      return [browser("open", url)];
    case 1: {
      const ref = refOf(last, "textbox", "Name");
      return ref ? [browser("fill", `@${ref}`, name)] : missing("Name field");
    }
    case 2: {
      const ref = knownRefOf(answers, "button", "Send");
      return ref ? [browser("click", `@${ref}`)] : missing("Send button");
    }
    case 3:
      return [
        {
          name: "emit_card",
          args: {
            id: "try-sign-up",
            title: MOCK_BROWSER_CARD_TITLE,
            body:
              `<p>The sign-up page said "Thanks, ${name}" after I typed the name and pressed Send.</p>` +
              "<p>Its browser is still open on this Mac, so you can try the page yourself.</p>" +
              `<ol>${MOCK_BROWSER_CARD_STEPS.map((step) => `<li>${step}</li>`).join("")}</ol>`,
            actions: [
              { id: "change-words", label: "Change the words" },
              { id: "looks-right", label: MOCK_BROWSER_CARD_DEFAULT, default: true },
            ],
            browser_button: MOCK_BROWSER_BUTTON,
          },
        },
      ];
    case 4:
      return [{ name: "report", args: { text: MOCK_BROWSER_CARD_REPORT } }];
    default:
      return undefined;
  }
}

/**
 * A crewmate saves its page's start (docs/task-browser.md, "Starting a page
 * again"; task-browser-start.spec.ts). A brief carrying this marker, the
 * page this Mac serves ("start the build page at http://127.0.0.1:PORT/
 * then") opens its browser there with `--start` and the command that
 * starts its build (`buildPageCommand`) while nothing answers, puts up a
 * card with a Try it button, and reports. Woken because nothing answers,
 * it reports that.
 */
export const TASK_BROWSER_START_MARKER = "start the build page at ";
export const MOCK_START_CARD_TITLE = "The build page is up to try";
export const MOCK_START_CARD_REPORT = "The build page is up behind its Try it card.";
export const MOCK_START_WOKEN_REPORT = "Nothing answered at the build page, so I was woken.";

/** The build page's own title, which its page shows once it answers. */
export const BUILD_PAGE_TITLE = "Build page";

/**
 * Each build page's gate, by its port: a file the journey makes when the
 * build may answer, so what the view shows while it starts follows the
 * journey's order, never a clock. The stand-in runs in the journey's own
 * process, so the journey sets it here.
 */
export const BUILD_PAGE_GATES = new Map<number, string>();

/**
 * The command that starts the build page: a real server on this computer
 * that serves its port once its gate is open, as a project's build does
 * once it compiles.
 */
export function buildPageCommand(port: number): string {
  const page = `<!doctype html><title>${BUILD_PAGE_TITLE}</title><h1>${BUILD_PAGE_TITLE}</h1><p>The build answers.</p>`;
  const code = `require("http").createServer((q, s) => { s.writeHead(200, { "content-type": "text/html; charset=utf-8" }); s.end(${JSON.stringify(page)}); }).listen(${port}, "127.0.0.1")`;
  const gate = BUILD_PAGE_GATES.get(port);
  const wait = gate ? `while [ ! -f '${gate}' ]; do sleep 0.05; done; ` : "";
  return `${wait}exec '${process.execPath}' -e '${code}'`;
}

/** The saved start's next scripted step, from the browser answers so far. */
function taskBrowserStartStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/start the build page at (http:\/\/127\.0\.0\.1:(\d+)\/) then/);
  if (!ask) return undefined;
  const [, url, port] = ask as unknown as [string, string, string];
  const command = buildPageCommand(Number(port));
  const messages = providerMessages(body);
  const woken = messages.findLastIndex(
    (message) => message.role === "user" && message.text.includes(PAGE_UNANSWERED_OPENING),
  );
  if (woken !== -1) {
    return toolAnswers(messages, woken).length === 0
      ? [{ name: "report", args: { text: MOCK_START_WOKEN_REPORT } }]
      : undefined;
  }
  const answers = toolAnswers(messages);
  // The open waits for the build to answer, which can outlast the shell's
  // limit: its answer then comes with the next bare command.
  const opened = answers.find((answer) => answer.includes("--start command"));
  if (!opened) {
    if (answers.length === 0) return [browser("open", url, "--start", command, "--within", "60")];
    const last = answers.at(-1) ?? "";
    if (last.includes("running: open") && answers.length < 10) return [browser()];
    return [
      { name: "report", args: { text: `The build page did not open: ${last.slice(0, 400)}` } },
    ];
  }
  if (toolCallCount(body, "emit_card") === 0) {
    return [
      {
        name: "emit_card",
        args: {
          id: "try-build",
          title: MOCK_START_CARD_TITLE,
          body: "<p>The build page answers. Its browser is still open on this Mac, so you can try it yourself.</p>",
          actions: [
            { id: "change-it", label: "Change it" },
            { id: "looks-right", label: "Looks right", default: true },
          ],
          browser_button: MOCK_BROWSER_BUTTON,
        },
      },
    ];
  }
  const reported = toolCallCount(body, "report") > 0;
  return reported
    ? undefined
    : [{ name: "report", args: { text: `${MOCK_START_CARD_REPORT} ${opened}` } }];
}

/**
 * The captain takes a task's browser while its crewmate's command runs
 * (docs/task-browser.md, "Taking control"; task-browser-handoff.spec.ts). A brief
 * carrying this marker and the account page this Mac serves ("keep the
 * account page at http://127.0.0.1:PORT/ open") opens its browser there and
 * waits on the page for "Ready to go on", again and again, its turn
 * running, until its browser refuses it; then it reports that refusal and
 * the answer before it. Woken by Return control, it takes its fresh look
 * and reports what the page says, read off the tool results.
 */
export const TASK_BROWSER_TAKE_MARKER = "keep the account page at ";
export const MOCK_TAKE_REFUSED_REPORT = "The captain took my browser while I waited on the page.";
export const MOCK_TAKE_RETURNED_REPORT = "The captain handed my browser back.";

function taskBrowserTakeStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/keep the account page at (http:\/\/127\.0\.0\.1:\d+\/) open/);
  if (!ask) return undefined;
  const url = ask[1] as string;
  const messages = providerMessages(body);
  const wake = messages.findLastIndex(
    (message) => message.role === "user" && message.text.includes(BROWSER_RETURNED_OPENING),
  );
  const answers = toolAnswers(messages, wake === -1 ? 0 : wake);
  if (answers.some((text) => text.startsWith("Reported."))) return undefined;
  const report = (text: string): ScriptedCall[] => [{ name: "report", args: { text } }];
  if (wake === -1) {
    if (answers.length === 0) return [browser("open", url)];
    const refused = answers.findIndex((text) =>
      text.startsWith("The captain has control of this task's browser"),
    );
    if (refused === -1) {
      return [browser("wait", TASK_BROWSER_HANDOFF_READY_WORDS)];
    }
    return report(
      `${MOCK_TAKE_REFUSED_REPORT} ${MOCK_BROWSER_SAID.commandBefore} "${firstSentence(answers[refused - 1])}" ${MOCK_BROWSER_SAID.refusal} "${firstSentence(answers[refused])}"`,
    );
  }
  if (answers.length === 0) return [browser("snapshot")];
  const state = answers[0]?.match(/text "((?:Not signed in|Signed in as [^"]+))"/)?.[1];
  return report(
    `${MOCK_TAKE_RETURNED_REPORT} ${MOCK_BROWSER_SAID.freshLook} "${firstSentence(answers[0])}" and ${MOCK_BROWSER_SAID.page} "${state}".`,
  );
}

/**
 * One task's browser reaches nothing of another's, nor a private address a
 * redirect leads to (docs/task-browser.md, "Where a page may go";
 * task-browser.spec.ts). A brief carrying this marker and a page this Mac
 * serves, "for task A", opens it twice and reports what it says. With
 * "beside" a second page's address, the crewmate opens its own page - which
 * asks the other task's server for data and a picture - then asks the
 * captain to take over the other task's site, follows two redirects of its
 * own page's, one to a public name that leads to this Mac and one to a
 * private address, opens the other task's page itself, and reports what each
 * answer said, read off the tool results.
 */
export const TASK_BROWSER_FENCE_MARKER = "fence the page at ";
export const MOCK_FENCE_A_REPORT = "Task A's page said";
export const MOCK_FENCE_B_REPORT = "Task B's browser said";
/** The card task B asks to take over the other task's site with, which the host refuses. */
export const MOCK_FENCE_B_HANDOFF_TITLE = "Sign in to the other task's page";
/** The words task B's report puts before each answer it quotes. */
export const MOCK_FENCE_B_SAID = {
  request: "The request:",
  publicName: "The redirect to a public name:",
  privateAddress: "The redirect to a private address:",
  otherPage: "The other task's page:",
} as const;

function taskBrowserFenceStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(
    /fence the page at (http:\/\/127\.0\.0\.1:\d+\/) (for task A|beside (http:\/\/127\.0\.0\.1:\d+\/))/,
  );
  if (!ask) return undefined;
  const [, own, , other] = ask as unknown as [string, string, string, string | undefined];
  const messages = providerMessages(body);
  const answers = toolAnswers(messages, 0);
  if (answers.some((text) => text.startsWith("Reported."))) return undefined;
  const report = (text: string): ScriptedCall[] => [{ name: "report", args: { text } }];
  const visits = (text: string | undefined) => text?.match(/text "(Visited [^"]+)"/)?.[1];
  if (!other) {
    switch (answers.length) {
      case 0:
        return [browser("open", own)];
      case 1:
        return [browser("open", own)];
      default:
        return report(`${MOCK_FENCE_A_REPORT} "${visits(answers[1])}".`);
    }
  }
  switch (answers.length) {
    case 0:
      return [browser("open", own)];
    case 1:
      return [
        {
          name: "emit_card",
          args: {
            id: "other-task-sign-in",
            title: MOCK_FENCE_B_HANDOFF_TITLE,
            body: "<p>The other page needs your sign-in.</p><p>I paused my browser for you.</p>",
            browser_handoff: {
              site: new URL(other).host,
              reason: "The other page needs your sign-in",
              after: "read the other page",
            },
            actions: [
              { id: "leave", label: MOCK_LEAVE_WAITING },
              {
                id: "sign-in",
                label: "Open browser and sign in",
                default: true,
                effect: { kind: "open", target: "browser" },
              },
            ],
          },
        },
      ];
    case 2:
      return [browser("open", `${own}leave`)];
    case 3:
      return [browser("open", `${own}intranet`)];
    case 4:
      return [browser("open", other)];
    default: {
      const line = (text: string | undefined, start: string) =>
        text?.split("\n").find((each) => each.startsWith(start));
      return report(
        `${MOCK_FENCE_B_REPORT}: "${line(answers[0], `Blocked what the page asked for from other servers on ${HERE.this}`)}" ${MOCK_FENCE_B_SAID.request} "${answers[1]?.split("\n")[0]}" ${MOCK_FENCE_B_SAID.publicName} "${line(answers[2], `Blocked what the page asked for on ${HERE.this}'s network`)}" ${MOCK_FENCE_B_SAID.privateAddress} "${line(answers[3], `Blocked what the page asked for on ${HERE.this}'s network`)}" ${MOCK_FENCE_B_SAID.otherPage} "${visits(answers[4])}".`,
      );
    }
  }
}

const JOURNEYS: ReadonlyArray<
  [marker: string, step: (body: string) => ScriptedCall[] | undefined, endsAtReport: boolean]
> = [
  [TASK_BROWSER_READING_MARKER, taskBrowserReadingStep, true],
  [TASK_BROWSER_LONG_MARKER, taskBrowserLongStep, true],
  [TASK_BROWSER_PAGES_MARKER, taskBrowserPagesStep, true],
  [TASK_BROWSER_WATCH_MARKER, taskBrowserWatchStep, true],
  [TASK_BROWSER_SAVED_MARKER, taskBrowserSavedStep, false],
  [TASK_BROWSER_HANDOFF_MARKER, taskBrowserHandoffStep, false],
  [TASK_BROWSER_LOCAL_RETURN_MARKER, taskBrowserLocalReturnStep, false],
  [TASK_BROWSER_TAKE_MARKER, taskBrowserTakeStep, false],
  [TASK_BROWSER_FENCE_MARKER, taskBrowserFenceStep, false],
  [TASK_BROWSER_CARD_MARKER, taskBrowserCardStep, false],
  [TASK_BROWSER_START_MARKER, taskBrowserStartStep, false],
];

/** The task browser's journeys past the plain sign-up page, for the crewmate whose brief names one. */
export const taskBrowserJourneys: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream) return undefined;
    const journey = JOURNEYS.find(([marker]) => body.includes(marker));
    if (!journey) return undefined;
    const [, step, endsAtReport] = journey;
    const calls = endsAtReport && calledTool(body, "report") ? undefined : lookingAgain(body, step);
    if (calls && step === taskBrowserHandoffStep && answerWaits(body)) return { threadHeld: calls };
    return calls ? { calls } : { text: "done" };
  };
