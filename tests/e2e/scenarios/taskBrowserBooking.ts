import { HIDDEN_VALUE_WORDS } from "../../../src/core/browser/outline";
import {
  BROWSER_GONE_OPENING,
  BROWSER_RETURNED_OPENING,
  CARD_CLOSED_STEER_PREFIX,
} from "../../../src/core/orchestrator/captainWakes";
import { BROWSER_PAY_STEP, BROWSER_SIGN_IN_STEP } from "../../../src/core/pi/cardTool";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import {
  browser,
  firstSentence,
  lookingAgain,
  MOCK_LEAVE_WAITING,
  refOf,
  toolAnswers,
} from "../browserScript";
import type { Scenario } from "../mockProvider";
import { providerMessages } from "../providerRequest";

/**
 * Booking a flight in a task's browser (docs/task-browser.md, "A final
 * submission"; tests/e2e/task-browser-booking.spec.ts). A brief carrying
 * this marker, the invented airline this Mac serves and a passenger ("book
 * the Lisbon flight at http://aurora.localhost:PORT/ for Sam Rivera")
 * books the way the crewmate's instructions say, on Pi and on Claude alike:
 *
 * 1. It opens the airline's search and asks which fare to prepare, on a
 *    decision whose door reads View search.
 * 2. Told to prepare the 07:40 nonstop, it selects it, meets the airline's
 *    sign-in, and asks the captain to sign in on an ordinary request card.
 *    Told the captain closed that card, it says its browser stays paused.
 * 3. Woken by Return control, it fills in the passenger details and goes on
 *    to the payment page, where it stops: its review card names the trip,
 *    the passenger, the seller, the total and currency, the baggage, the
 *    fare rules and what is still uncertain, marks a total that changed
 *    since the search, and asks the captain to make the payment himself.
 * 4. Woken again, it reads the confirmation and leaves a note with the
 *    reference, its door reading View booking.
 *
 * Every value it reports is read off the tool results, never assumed.
 */
export const TASK_BROWSER_BOOKING_MARKER = "book the Lisbon flight at ";
export const MOCK_FARES_CARD_TITLE = "Three fares fit 18 to 25 Oct";
export const MOCK_FARES_CHOICE = "Prepare the 07:40 nonstop";
export const MOCK_FARES_BUTTON = "View search";
export const MOCK_FARES_ASKED_REPORT = "I compared three fares and asked which one to prepare.";
export const MOCK_AIRLINE_SIGN_IN_TITLE = "Sign in to Aurora Air to hold the fare";
export const MOCK_AIRLINE_SIGN_IN_ACTION = BROWSER_SIGN_IN_STEP;
export const MOCK_AIRLINE_SIGN_IN_REPORT = "I asked the captain to sign in to Aurora Air.";
export const MOCK_SIGN_IN_CLOSED_REPORT =
  "The captain closed my sign-in request without choosing; my browser stays paused on the sign-in for the captain.";
export const MOCK_REVIEW_PAY_ACTION = BROWSER_PAY_STEP;
export const MOCK_REVIEW_STOP_ACTION = "Stop here";
export const MOCK_REVIEW_REPORT_PREFIX = "I prepared the booking and stopped before paying.";
export const MOCK_BOOKED_BUTTON = "View booking";
export const MOCK_BOOKED_REPORT_PREFIX = "Booked:";
/** The facts the review card names, one row each, in its order. */
export const MOCK_REVIEW_FACTS = [
  "Route",
  "Dates",
  "Passenger",
  "Seller",
  "Total",
  "Baggage",
  "Fare rules",
  "Still uncertain",
] as const;
/** The review card's title: the total and the site, as the payment page shows them. */
export const reviewCardTitle = (total: string, site: string): string =>
  `Ready to pay ${total} on ${site}`;
/** The booked note's title, with the reference the confirmation gave. */
export const bookedNoteTitle = (reference: string): string =>
  `Booked: London to Lisbon, 18 to 25 Oct, ${reference}`;

/** Where a booking conversation stands: the wakes it has had, newest last, by kind and place. */
type BookingSteer = { kind: "choice" | "closed" | "returned"; at: number };
function bookingSteers(messages: ReturnType<typeof providerMessages>): BookingSteer[] {
  return messages.flatMap((message, at): BookingSteer[] => {
    if (message.role !== "user") return [];
    if (message.text.includes(`chose "${MOCK_FARES_CHOICE}"`)) return [{ kind: "choice", at }];
    if (message.text.includes(CARD_CLOSED_STEER_PREFIX.trim())) return [{ kind: "closed", at }];
    if (message.text.includes(BROWSER_RETURNED_OPENING)) return [{ kind: "returned", at }];
    return [];
  });
}

/** What the review card marks when the total moved since the search. */
export function fareRoseWords(searched: string, total: string): string {
  return `The total rose from ${searched} to ${total} since the search`;
}

/** A review card for the payment page the crewmate stopped on (docs/task-browser.md, "A final submission"). */
function reviewCard(
  site: string,
  passenger: string,
  total: string,
  searched: string | undefined,
): ScriptedCall {
  const changed =
    searched && `${searched}.00` !== total
      ? `<p><mark>${fareRoseWords(searched, total)}</mark>, so I stopped for your review.</p>`
      : "";
  return {
    name: "emit_card",
    args: {
      id: "review-and-pay",
      title: reviewCardTitle(total, site),
      body:
        "<p>I filled in the booking and stopped before paying: the payment is yours to make on Aurora Air's page.</p>" +
        "<table>" +
        MOCK_REVIEW_FACTS.map(
          (fact) =>
            `<tr><td>${fact}</td><td>${
              {
                Route: "London Heathrow (LHR) to Lisbon (LIS), nonstop both ways",
                Dates: "Sat 18 Oct, 07:40 London time · return Sat 25 Oct, 18:05 Lisbon time",
                Passenger: `${passenger}, 1 adult`,
                Seller: `Aurora Air, ${site}`,
                Total: `${total} EUR`,
                Baggage: "1 cabin bag, no checked bag",
                "Fare rules": "Non-refundable, changes €60",
                "Still uncertain": "Seats are assigned at check-in",
              }[fact]
            }</td></tr>`,
        ).join("") +
        "</table>" +
        changed +
        "<p>You enter the card details on Aurora Air's page. Infinitary records none of them.</p>",
      browser_handoff: {
        site,
        reason: "The final payment is yours to make",
        after: "read the confirmation and keep the reference",
      },
      actions: [
        { id: "stop-here", label: MOCK_REVIEW_STOP_ACTION },
        {
          id: "pay",
          label: MOCK_REVIEW_PAY_ACTION,
          default: true,
          effect: { kind: "open", target: "browser" },
        },
      ],
    },
  };
}

/** The booking journey's next scripted step, from the wakes and browser answers so far. */
function taskBrowserBookingStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(
    /book the Lisbon flight at (http:\/\/aurora\.localhost:\d+\/) for ([A-Z][a-z]+ [A-Z][a-z]+)/,
  );
  if (!ask) return undefined;
  const [, url, passenger] = ask as unknown as [string, string, string];
  const site = new URL(url).host;
  const messages = providerMessages(body);
  const steers = bookingSteers(messages);
  const last = steers.at(-1);
  const answers = toolAnswers(messages, last?.at ?? 0);
  // Its report's own answer: this turn has said what it found.
  if (answers.some((text) => text.startsWith("Reported."))) return undefined;
  const report = (text: string): ScriptedCall[] => [{ name: "report", args: { text } }];
  const refused = (answer: string | undefined): string =>
    answer?.startsWith("Card refused") ? ` ${answer}` : "";
  const search = toolAnswers(messages, 0)[0];
  const searched = search?.match(/text "07:40 to 10:25 · nonstop · (€\d+)/)?.[1];
  if (!last) {
    switch (answers.length) {
      case 0:
        return [browser("open", url)];
      case 1:
        return [
          {
            name: "emit_card",
            args: {
              id: "choose-fare",
              title: MOCK_FARES_CARD_TITLE,
              body:
                `<p>I would prepare the 07:40 nonstop at ${searched ?? "its fare"}: it costs €67 more than the cheapest and saves about 3 hours each way.</p>` +
                "<table>" +
                `<tr><td>Aurora Air · 07:40 · nonstop</td><td>${searched ?? "not shown"}</td></tr>` +
                "<tr><td>Aurora Air · 09:15 · 1 stop in Madrid</td><td>€231</td></tr>" +
                "<tr><td>Aurora Air · 13:30 · 1 stop in Paris</td><td>€254</td></tr>" +
                "</table>",
              browser_button: MOCK_FARES_BUTTON,
              actions: [
                { id: "more", label: "Show me more" },
                { id: "prepare", label: MOCK_FARES_CHOICE, default: true },
              ],
            },
          },
        ];
      case 2:
        return report(`${MOCK_FARES_ASKED_REPORT}${refused(answers[1])}`);
      default:
        return undefined;
    }
  }
  if (last.kind === "choice") {
    switch (answers.length) {
      case 0: {
        const ref = refOf(search, "link", "Select the 07:40 nonstop");
        return ref
          ? [browser("click", `@${ref}`)]
          : report(`No Select link for the 07:40 nonstop: ${(search ?? "").slice(0, 400)}`);
      }
      case 1:
        return [
          {
            name: "emit_card",
            args: {
              id: "airline-sign-in",
              title: MOCK_AIRLINE_SIGN_IN_TITLE,
              body: "<p>Aurora Air needs your account to hold the fare, so I paused the browser on its sign-in page.</p><p>While you have control I cannot see the page, and your typing is not recorded.</p>",
              browser_handoff: {
                site,
                reason: "Aurora Air needs your account to hold the fare",
                after: "fill in the passenger details",
              },
              actions: [
                { id: "leave", label: MOCK_LEAVE_WAITING },
                {
                  id: "sign-in",
                  label: MOCK_AIRLINE_SIGN_IN_ACTION,
                  default: true,
                  effect: { kind: "open", target: "browser" },
                },
              ],
            },
          },
        ];
      case 2:
        return report(`${MOCK_AIRLINE_SIGN_IN_REPORT}${refused(answers[1])}`);
      default:
        return undefined;
    }
  }
  if (last.kind === "closed") return report(MOCK_SIGN_IN_CLOSED_REPORT);
  const returns = steers.filter((steer) => steer.kind === "returned").length;
  if (returns === 1) {
    const form = answers[0];
    switch (answers.length) {
      case 0:
        return [browser("snapshot")];
      case 1: {
        const ref = refOf(form, "textbox", "Full name");
        return ref
          ? [browser("fill", `@${ref}`, passenger)]
          : report(`No passenger form after the sign-in: ${(form ?? "").slice(0, 400)}`);
      }
      case 2: {
        const ref = refOf(form, "textbox", "Date of birth");
        return ref
          ? [browser("fill", `@${ref}`, "12 Mar 1988")]
          : report(`No date of birth field: ${(form ?? "").slice(0, 400)}`);
      }
      case 3: {
        const ref = refOf(form, "button", "Continue to payment");
        return ref
          ? [browser("click", `@${ref}`)]
          : report(`No Continue to payment button: ${(form ?? "").slice(0, 400)}`);
      }
      case 4: {
        const total = answers[3]?.match(/text "Total (€[\d.]+) \(EUR\)"/)?.[1];
        return total
          ? [reviewCard(site, passenger, total, searched)]
          : report(`No total on the payment page: ${(answers[3] ?? "").slice(0, 400)}`);
      }
      case 5: {
        const total = answers[3]?.match(/text "Total (€[\d.]+) \(EUR\)"/)?.[1];
        return report(
          `${MOCK_REVIEW_REPORT_PREFIX} The total is ${total}; the search said ${searched}.${refused(answers[4])}`,
        );
      }
      default:
        return undefined;
    }
  }
  switch (answers.length) {
    case 0:
      return [browser("snapshot")];
    case 1: {
      const reference = answers[0]?.match(/text "Reference (AUR-\w+)"/)?.[1];
      if (!reference) {
        return report(`The page did not confirm the booking: ${(answers[0] ?? "").slice(0, 400)}`);
      }
      return [
        {
          name: "emit_card",
          args: {
            id: "booked",
            title: bookedNoteTitle(reference),
            body: `<p>I read Aurora Air's confirmation after you returned control. The reference is ${reference}, and the receipt went to your Aurora Air account email.</p><p>I kept the itinerary and the reference, not the page itself.</p>`,
            browser_button: MOCK_BOOKED_BUTTON,
          },
        },
      ];
    }
    case 2: {
      const reference = answers[0]?.match(/text "Reference (AUR-\w+)"/)?.[1];
      return report(`${MOCK_BOOKED_PREFIX_TEXT(reference)}${refused(answers[1])}`);
    }
    default:
      return undefined;
  }
}

const MOCK_BOOKED_PREFIX_TEXT = (reference: string | undefined): string =>
  `${MOCK_BOOKED_REPORT_PREFIX} London to Lisbon, 18 to 25 Oct, reference ${reference}. I kept the itinerary and the reference, not the page.`;

/**
 * A payment whose answer is lost, then a restart (docs/task-browser.md, "A
 * final submission"; tests/e2e/task-browser-booking.spec.ts). A brief
 * carrying this marker and the airline's payment page ("pay for the held
 * Lisbon fare at http://aurora.localhost:PORT/pay") opens the page and
 * stops before paying, on a review card that asks the captain to pay.
 * Woken by Return control on a page that could not confirm the payment, it
 * tries to reload it - as a careless crewmate would, so the browser's
 * refusal shows - then looks at My bookings and keeps watching it for a
 * confirmation that never comes, its turn running. Woken once more, after
 * the app restarted and redelivered that wake, it finds its browser gone,
 * opens My bookings afresh, and asks the captain to check in the browser,
 * on a decision that says the outcome is unknown and that it did not pay
 * again. Told that the captain chose to check on that card after the app
 * quit once more, with its browser gone, it opens My bookings again and asks
 * anew on a new card. Every value it reports is read off the tool results.
 */
export const TASK_BROWSER_LOST_MARKER = "pay for the held Lisbon fare at ";
export const MOCK_LOST_ASKED_REPORT = "I prepared the payment and stopped before paying.";
export const MOCK_LOST_CHECK_ACTION = "Open browser and check";
export const MOCK_LOST_NOT_BOOKED_ACTION = "Treat as not booked";
export const MOCK_LOST_REPORT_PREFIX = "The payment's outcome on Aurora Air is unknown.";
/** The words the lost payment's report puts before each answer it quotes. */
export const MOCK_LOST_SAID = {
  bookings: "My bookings said",
  notAgain: "and I did not pay again.",
  reload: "Reloading the unconfirmed page said:",
  restart: "After the restart my browser was gone:",
} as const;
export const MOCK_LOST_ASKED_AGAIN_REPORT =
  "My browser was gone when the captain chose to check, so I opened My bookings again and asked anew.";
/** The decision that says the outcome is unknown. */
export const unknownCardTitle = (site: string): string => `The payment on ${site} is unknown`;

/** The decision that asks the captain to check a payment whose outcome is unknown, in the browser. */
function unknownCard(site: string, id: string, lead: string): ScriptedCall {
  return {
    name: "emit_card",
    args: {
      id,
      title: unknownCardTitle(site),
      body: `<p>${lead}</p><p>Its bookings page shows nothing yet, and your bank may show a pending charge. Check in the browser before anything else is paid.</p>`,
      browser_handoff: {
        site,
        reason: "Aurora Air never confirmed your payment",
        after: "read what you found and report it",
      },
      actions: [
        { id: "not-booked", label: MOCK_LOST_NOT_BOOKED_ACTION },
        {
          id: "check",
          label: MOCK_LOST_CHECK_ACTION,
          default: true,
          effect: { kind: "open", target: "browser" },
        },
      ],
    },
  };
}

/** The lost payment's next scripted step, from the wakes and browser answers so far. */
function taskBrowserLostStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/pay for the held Lisbon fare at (http:\/\/aurora\.localhost:\d+\/)pay/);
  if (!ask) return undefined;
  const home = ask[1] as string;
  const site = new URL(home).host;
  const messages = providerMessages(body);
  const report = (text: string): ScriptedCall[] => [{ name: "report", args: { text } }];
  // The captain chose to check on a card whose browser was gone: it asks anew.
  const told = messages.findLastIndex(
    (message) => message.role === "user" && message.text.includes(BROWSER_GONE_OPENING),
  );
  if (told !== -1) {
    const again = toolAnswers(messages, told);
    if (again.some((text) => text.startsWith("Reported."))) return undefined;
    switch (again.length) {
      case 0:
        return [browser("open", `${home}bookings`)];
      case 1:
        return [
          unknownCard(
            site,
            "payment-unknown-again",
            "My browser was gone when you chose to check, so I opened Aurora Air's bookings again. It still has not confirmed the payment, and I did not pay again.",
          ),
        ];
      case 2:
        return report(
          `${MOCK_LOST_ASKED_AGAIN_REPORT}${again[1]?.startsWith("Card refused") ? ` ${again[1]}` : ""}`,
        );
      default:
        return undefined;
    }
  }
  const steers = bookingSteers(messages).filter((steer) => steer.kind === "returned");
  const last = steers.at(-1);
  const answers = toolAnswers(messages, last?.at ?? 0);
  if (answers.some((text) => text.startsWith("Reported."))) return undefined;
  if (!last) {
    switch (answers.length) {
      case 0:
        return [browser("open", `${home}pay`)];
      case 1: {
        const total = answers[0]?.match(/text "Total (€[\d.]+) \(EUR\)"/)?.[1] ?? "the total";
        return [reviewCard(site, "Sam Rivera", total, undefined)];
      }
      case 2:
        return report(
          `${MOCK_LOST_ASKED_REPORT}${answers[1]?.startsWith("Card refused") ? ` ${answers[1]}` : ""}`,
        );
      default:
        return undefined;
    }
  }
  if (answers.length === 0) return [browser("snapshot")];
  const gone = answers[0]?.includes("No browser is open");
  if (!gone) {
    // Before the restart: the page could not confirm the payment.
    if (answers.length === 1) return [browser("reload")];
    if (answers.length === 2) {
      return [browser("open", `${home}bookings`)];
    }
    // Watching My bookings for a confirmation that never comes: its turn runs on.
    return [browser("wait", "Booking confirmed")];
  }
  switch (answers.length) {
    case 1:
      return [browser("open", `${home}bookings`)];
    case 2:
      return [
        unknownCard(
          site,
          "payment-unknown",
          "Aurora Air did not confirm the payment after you pressed Pay, and I did not pay again.",
        ),
      ];
    case 3: {
      const all = toolAnswers(messages, 0);
      const reload = all
        .flatMap((text) => text.split("\n"))
        .map((line) => line.replace(/^did: /, ""))
        .find((line) => line.startsWith("Did not reload"));
      const listed = answers[1]?.match(/text "(No bookings yet[^"]*)"/)?.[1];
      return report(
        `${MOCK_LOST_REPORT_PREFIX} ${MOCK_LOST_SAID.bookings} "${listed}", ${MOCK_LOST_SAID.notAgain}${reload ? ` ${MOCK_LOST_SAID.reload} "${reload}"` : ""} ${MOCK_LOST_SAID.restart} "${firstSentence(answers[0])}"${answers[2]?.startsWith("Card refused") ? ` ${answers[2]}` : ""}`,
      );
    }
    default:
      return undefined;
  }
}

/**
 * A payment the captain leaves unpaid (docs/task-browser.md, "A signed-in
 * page"; tests/e2e/task-browser-booking.spec.ts). A brief carrying this
 * marker and the airline's payment page ("prepare the Lisbon payment at
 * http://aurora.localhost:PORT/pay") opens the page and stops before
 * paying, on a review card that asks the captain to pay. Woken by Return
 * control on the page with his card details typed and never sent, it takes
 * its fresh look, asks for a picture of the page with a reason, and
 * reports how each card field read and what the picture's answer said.
 * Every value it reports is read off the tool results.
 */
export const TASK_BROWSER_UNPAID_MARKER = "prepare the Lisbon payment at ";
export const MOCK_UNPAID_ASKED_REPORT = "I prepared the payment for the captain to make.";
export const MOCK_UNPAID_REPORT_PREFIX = "The captain handed the payment page back unpaid.";
export const MOCK_UNPAID_PICTURE = "unpaid-payment";
/** The card fields the crewmate reads after the return, by their labels on the page. */
export const MOCK_UNPAID_FIELDS = ["Card number", "Expiry", "Security code"] as const;

/** The unpaid payment's next scripted step, from the wakes and browser answers so far. */
function taskBrowserUnpaidStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/prepare the Lisbon payment at (http:\/\/aurora\.localhost:\d+\/)pay/);
  if (!ask) return undefined;
  const home = ask[1] as string;
  const site = new URL(home).host;
  const messages = providerMessages(body);
  const last = bookingSteers(messages)
    .filter((steer) => steer.kind === "returned")
    .at(-1);
  const answers = toolAnswers(messages, last?.at ?? 0);
  if (answers.some((text) => text.startsWith("Reported."))) return undefined;
  const report = (text: string): ScriptedCall[] => [{ name: "report", args: { text } }];
  if (!last) {
    switch (answers.length) {
      case 0:
        return [browser("open", `${home}pay`)];
      case 1: {
        const total = answers[0]?.match(/text "Total (€[\d.]+) \(EUR\)"/)?.[1] ?? "the total";
        return [reviewCard(site, "Sam Rivera", total, undefined)];
      }
      case 2:
        return report(
          `${MOCK_UNPAID_ASKED_REPORT}${answers[1]?.startsWith("Card refused") ? ` ${answers[1]}` : ""}`,
        );
      default:
        return undefined;
    }
  }
  switch (answers.length) {
    case 0:
      return [browser("snapshot")];
    case 1:
      return [
        browser(
          "screenshot",
          MOCK_UNPAID_PICTURE,
          "--reason",
          "the task needs to show what the payment page says now",
        ),
      ];
    case 2: {
      // Each field as the fresh look read it: its value, hidden, or not there.
      const lines = (answers[0] ?? "").split("\n").map((line) => line.trim());
      const read = MOCK_UNPAID_FIELDS.map((label) => {
        const line = lines.find((text) => text.startsWith(`textbox "${label}`));
        if (!line) return `${label}: missing`;
        if (line.includes(HIDDEN_VALUE_WORDS)) return `${label}: hidden`;
        return `${label}: ${line.match(/\]: ("[^"]*")/)?.[1] ?? "empty"}`;
      });
      return report(
        `${MOCK_UNPAID_REPORT_PREFIX} The fresh look read ${read.join("; ")}. The picture: "${firstSentence(answers[1])}"`,
      );
    }
    default:
      return undefined;
  }
}

/** Each booking journey's marker and its next step. */
const JOURNEYS: ReadonlyArray<
  [marker: string, step: (body: string) => ScriptedCall[] | undefined]
> = [
  [TASK_BROWSER_BOOKING_MARKER, taskBrowserBookingStep],
  [TASK_BROWSER_LOST_MARKER, taskBrowserLostStep],
  [TASK_BROWSER_UNPAID_MARKER, taskBrowserUnpaidStep],
];

/** Booking and paying in a task's browser, for the crewmate whose brief names one. */
export const taskBrowserBooking: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream) return undefined;
    const journey = JOURNEYS.find(([marker]) => body.includes(marker));
    if (!journey) return undefined;
    const calls = lookingAgain(body, journey[1]);
    return calls ? { calls } : { text: "done" };
  };
