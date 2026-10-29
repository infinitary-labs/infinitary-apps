import { BROWSER_RETURNED_OPENING } from "../../../src/core/orchestrator/wakes";
import { BROWSER_SIGN_IN_STEP } from "../../../src/core/pi/cardTool";
import { HERE } from "../../../src/shared/deviceNames";
import {
  answersAfter,
  browser,
  calledTool,
  firstSentence,
  HANDOFF_WAKE,
  knownRefOf,
  lookingAgain,
  refOf,
  type Scenario,
  type ScriptedCall,
  toolAnswers,
} from "../mockProvider";
import { providerMessages } from "../providerRequest";

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
      const moved = click.includes("/reading/one") ? "moved" : "stayed";
      const title = click.includes('heading "Firstmate 3000 0.2.1-alpha.52"')
        ? "new title"
        : "old title";
      const time = listed.includes("2026-10-08T21:52:52Z") ? "exact time" : "no time";
      const tip = listed.includes("Oct 8, 2026, 2:52 PM PDT") ? "title tooltip" : "no tooltip";
      const tail = notes.includes("anything stays secret in the notes")
        ? "notes in full"
        : "notes cut";
      const atom = feed.includes("feed ends with the atom tail") ? "feed in full" : "feed cut";
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
 * name, scrolls down, and reports what each answer actually showed.
 */
export const TASK_BROWSER_LONG_MARKER = "read the long changelog at ";
export const MOCK_BROWSER_LONG_REPORT_PREFIX = "The long changelog said";
/** Words only the changelog's last section holds. */
export const TASK_BROWSER_LONG_LAST_WORDS = "the last release ends here";

/** The first outline line an answer shows, from its `outline:` line. */
function firstShownLine(answer: string | undefined): number | undefined {
  const line = answer?.match(/^outline: lines (\d+)-\d+ of \d+/m)?.[1];
  return line === undefined ? undefined : Number(line);
}

function taskBrowserLongStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/read the long changelog at (http:\/\/127\.0\.0\.1:\d+\/long)/);
  if (!ask) return undefined;
  const url = ask[1] as string;
  const answers = toolAnswers(providerMessages(body));
  // The line the first answer says to read on from, read off its next lines.
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
      return [browser("stop")];
    case 5: {
      const [opened = "", found = "", read = "", scrolled = ""] = answers;
      const facts = [
        /^map\[\d+\]:$/m.test(opened) && opened.includes('region "Release 40"')
          ? "a map"
          : "no map",
        opened.includes("(same as line ") ? "folded repeats" : "no folds",
        (firstShownLine(found) ?? 1) > 1 &&
        found.includes(`text "And ${TASK_BROWSER_LONG_LAST_WORDS}."`)
          ? "found the end"
          : "did not find the end",
        readOn !== undefined && firstShownLine(read) === Number(readOn)
          ? "read on"
          : "did not read on",
        (firstShownLine(scrolled) ?? 1) > 1 && scrolled.includes(", those on screen")
          ? "scrolled past the top"
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
/** The words the bank's check shows once the spec lets the crewmate approve. */
export const TASK_BROWSER_APPROVE_WORDS = "Ready to approve";

/** The second-page journey's next scripted step, from the browser answers so far. */
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
    `"${firstSentence(answers[0])}" Then: "${opened}" The check: "${answers.some((text) => /^\s*page: 2 of 2$/m.test(text)) ? "page 2 of 2" : "one page"}". After Approve: "${closed}" The shop: "${paid}".`,
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

/** The watched check's next scripted step, from the browser answers so far. */
function taskBrowserWatchStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/watch the sign-up page at (http:\/\/127\.0\.0\.1:\d+\/) as (\w+)/);
  if (!ask) return undefined;
  const [, url, name] = ask as unknown as [string, string, string];
  const answers = toolAnswers(providerMessages(body));
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
 * reports, leaving its browser open for the captain to try.
 */
export const TASK_BROWSER_CARD_MARKER = "show the sign-up page at ";
export const MOCK_BROWSER_CARD_TITLE = "The sign-up page thanks the name after Send";
export const MOCK_BROWSER_BUTTON = "Try it";
export const MOCK_BROWSER_CARD_REPORT = "I left the sign-up page open for the captain to try.";

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
/** The picture it takes of the signed-in page, once with a reason (docs/task-browser.md, "A signed-in page"). */
export const MOCK_SIGNED_IN_PICTURE = "signed-in-account";
export const MOCK_SIGNED_IN_PICTURE_REASON = "the task needs to show which account is signed in";

/** The handoff's next scripted step, from the browser answers so far. */
function taskBrowserHandoffStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/sign in to the account page at (http:\/\/127\.0\.0\.1:\d+\/)/);
  if (!ask) return undefined;
  const url = ask[1] as string;
  const messages = providerMessages(body);
  const wake = messages.findIndex(
    (message) => message.role === "user" && message.text.includes(HANDOFF_WAKE),
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
                { id: "leave", label: "Leave waiting" },
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
              text: `${MOCK_HANDOFF_ASKED_REPORT} My browser then said: "${firstSentence(before[2])}"`,
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
        text: `${MOCK_HANDOFF_RETURNED_REPORT} The old ref: "${firstSentence(after[0])}" The fresh look said "${firstSentence(after[1])}" and the page said "${state}". It kept ${kept.length ? kept.join(" and ") : "nothing from the captain's time"}. A picture without a reason: "${refused.split("\n")[0]}" With one: "${saved.match(/^did: (.*?) \(/m)?.[1]}".`,
      },
    },
  ];
}

/**
 * A sign-in saved on this Mac reaches a later task (docs/task-browser.md,
 * "Saved sign-ins"). A brief carrying this marker and a club page this Mac
 * serves ("use the club page at http://127.0.0.1:PORT/ as ...") opens the
 * task's browser there and asks the captain to sign in on an ordinary
 * decision - the host may add a saved sign-in beside its own action - and
 * reports that it asked. Woken, by Return control or by the saved sign-in,
 * it opens the page again, so the club's server sees its sign-in, and
 * reports the wake's first sentence and what the page said, read off the
 * tool results, never assumed. When a saved sign-in left the page signed
 * out, it asks again on a card that says so (`saved_failed`,
 * INF-1849) and reports what that card's answer said.
 */
export const TASK_BROWSER_SAVED_MARKER = "use the club page at ";
export const MOCK_SAVED_CARD_TITLE = "Sign in to the club page to continue";
export const MOCK_SAVED_ACTION = BROWSER_SIGN_IN_STEP;
export const MOCK_SAVED_ASKED_REPORT = "I asked the captain to sign in to the club page.";
export const MOCK_SAVED_REPORT_PREFIX = "The club page said";
export const MOCK_SAVED_FAILED_CARD_TITLE = "Sign in to the club page again";
export const MOCK_SAVED_FAILED_REPORT = "The saved sign-in left the club page signed out.";
const SAVED_WAKES = [
  BROWSER_RETURNED_OPENING,
  `The captain let this task use the sign-in saved on ${HERE.this}`,
];

/** The saved sign-in journey's next scripted step, from the browser answers so far. */
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
            actions: [
              { id: "leave", label: "Leave waiting" },
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
            actions: [
              { id: "leave", label: "Leave waiting" },
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
      args: { text: `${MOCK_SAVED_REPORT_PREFIX} "${state}". The wake said "${woken}"` },
    },
  ];
}

/** The browser card's next scripted step, from the browser answers so far. */
function taskBrowserCardStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/show the sign-up page at (http:\/\/127\.0\.0\.1:\d+\/) as (\w+)/);
  if (!ask) return undefined;
  const [, url, name] = ask as unknown as [string, string, string];
  const answers = toolAnswers(providerMessages(body));
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
              "<p>Its browser is still open on this Mac, so you can try the page yourself.</p>",
            actions: [
              { id: "change-words", label: "Change the words" },
              { id: "looks-right", label: "Looks right", default: true },
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
 * The captain takes a task's browser while its crewmate's command runs
 * (docs/task-browser.md, "Taking control"; task-browser.spec.ts). A brief
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

/** The take-in-flight journey's next scripted step, from the wakes and browser answers so far. */
function taskBrowserTakeStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/keep the account page at (http:\/\/127\.0\.0\.1:\d+\/) open/);
  if (!ask) return undefined;
  const url = ask[1] as string;
  const messages = providerMessages(body);
  const wake = messages.findLastIndex(
    (message) => message.role === "user" && message.text.includes(HANDOFF_WAKE),
  );
  const answers = answersAfter(messages, wake === -1 ? 0 : wake);
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
      `${MOCK_TAKE_REFUSED_REPORT} The command before it answered "${firstSentence(answers[refused - 1])}" Then my browser said "${firstSentence(answers[refused])}"`,
    );
  }
  if (answers.length === 0) return [browser("snapshot")];
  const state = answers[0]?.match(/text "((?:Not signed in|Signed in as [^"]+))"/)?.[1];
  return report(
    `${MOCK_TAKE_RETURNED_REPORT} The fresh look said "${firstSentence(answers[0])}" and the page said "${state}".`,
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

/** The fence journey's next scripted step, from the browser answers so far. */
function taskBrowserFenceStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(
    /fence the page at (http:\/\/127\.0\.0\.1:\d+\/) (for task A|beside (http:\/\/127\.0\.0\.1:\d+\/))/,
  );
  if (!ask) return undefined;
  const [, own, , other] = ask as unknown as [string, string, string, string | undefined];
  const messages = providerMessages(body);
  const answers = answersAfter(messages, 0);
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
            title: "Sign in to the other task's page",
            body: "<p>The other page needs your sign-in.</p><p>I paused my browser for you.</p>",
            browser_handoff: {
              site: new URL(other).host,
              reason: "The other page needs your sign-in",
              after: "read the other page",
            },
            actions: [
              { id: "leave", label: "Leave waiting" },
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
        `${MOCK_FENCE_B_REPORT}: "${line(answers[0], `Blocked what the page asked for from other servers on ${HERE.this}`)}" The request: "${answers[1]?.split("\n")[0]}" The redirect to a public name: "${line(answers[2], `Blocked what the page asked for on ${HERE.this}'s network`)}" The redirect to a private address: "${line(answers[3], `Blocked what the page asked for on ${HERE.this}'s network`)}" The other task's page: "${visits(answers[4])}".`,
      );
    }
  }
}

/** Each browser journey's marker, its next step, and whether its report ends it. */
const JOURNEYS: ReadonlyArray<
  [marker: string, step: (body: string) => ScriptedCall[] | undefined, endsAtReport: boolean]
> = [
  [TASK_BROWSER_READING_MARKER, taskBrowserReadingStep, true],
  [TASK_BROWSER_LONG_MARKER, taskBrowserLongStep, true],
  [TASK_BROWSER_PAGES_MARKER, taskBrowserPagesStep, true],
  [TASK_BROWSER_WATCH_MARKER, taskBrowserWatchStep, true],
  [TASK_BROWSER_SAVED_MARKER, taskBrowserSavedStep, false],
  [TASK_BROWSER_HANDOFF_MARKER, taskBrowserHandoffStep, false],
  [TASK_BROWSER_TAKE_MARKER, taskBrowserTakeStep, false],
  [TASK_BROWSER_FENCE_MARKER, taskBrowserFenceStep, false],
  [TASK_BROWSER_CARD_MARKER, taskBrowserCardStep, true],
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
    return calls ? { calls } : { text: "done" };
  };
