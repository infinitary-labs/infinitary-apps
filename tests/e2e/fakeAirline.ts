import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Aurora Air, an invented airline for the booking journeys
 * (tests/e2e/task-browser-booking.spec.ts; docs/task-browser.md, "A final
 * submission"). It serves on this Mac's loopback under the name
 * `aurora.localhost`, which the browser resolves to this Mac itself, so
 * nothing reaches a network. Every account, passenger and card is
 * synthetic.
 *
 * Search lists three fares, the 07:40 nonstop at €298. Choosing it needs a
 * sign-in (a form that answers with a redirect), then passenger details
 * (the same), then the payment page, whose total is €312 - the fare rose
 * since the search. Pay is a form whose answer is the next page: the
 * confirmation, AUR-7K2Q, or, when the airline `loses` the answer, a page
 * that says it is processing and asks its status of a server that never
 * answers, then that it could not confirm the payment. My bookings lists a
 * confirmed booking, or none while one may still be processing.
 *
 * The airline counts every payment it is sent, which is what a journey
 * proves was sent once.
 */

export const AIRLINE_HOST = "aurora.localhost";
export const SEARCH_FARE = "€298";
export const PAY_TOTAL = "€312.00";
export const BOOKING_REFERENCE = "AUR-7K2Q";
export const SYNTHETIC_EMAIL = "sam@aurora.example";
export const SYNTHETIC_PASSWORD = "aurora-synthetic-pass-7";
export const SYNTHETIC_CARD = "0000 1111 2222 3333";
export const SYNTHETIC_EXPIRY = "12/29";
export const SYNTHETIC_CODE = "7406";

export type FakeAirline = {
  /** `http://aurora.localhost:PORT/`. */
  url: string;
  /** Where the browser shows it: `aurora.localhost:PORT`. */
  site: string;
  /** Every payment the airline was sent, with the total it was for. */
  payments: { total: string; card: string }[];
  close: () => Promise<void>;
};

const STYLE =
  "<style>body { background: rgb(28, 54, 110); color: white; font: 18px sans-serif; margin: 32px; } input, button { font: inherit; margin: 6px 0; } label { display: block; } table td { padding: 2px 12px 2px 0; }</style>";

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title>${STYLE}</head><body>${body}</body></html>`;
}

const ITINERARY = `<table>
<tr><td>Outbound</td><td>Sat 18 Oct, London Heathrow (LHR) 07:40 to Lisbon (LIS) 10:25, local times, nonstop</td></tr>
<tr><td>Return</td><td>Sat 25 Oct, Lisbon (LIS) 18:05 to London Heathrow (LHR) 20:40, local times, nonstop</td></tr>
<tr><td>Baggage</td><td>1 cabin bag, no checked bag</td></tr>
<tr><td>Fare rules</td><td>Non-refundable, changes €60</td></tr>
</table>`;

const SEARCH = page(
  "Aurora Air flights",
  `<h1>Flights from London to Lisbon</h1>
<p>London Heathrow (LHR) to Lisbon (LIS) · Sat 18 Oct to Sat 25 Oct · 1 adult · economy</p>
<ul>
<li>07:40 to 10:25 · nonstop · ${SEARCH_FARE} <a href="/fare/0740">Select the 07:40 nonstop</a></li>
<li>09:15 to 14:50 · 1 stop in Madrid · €231 <a href="/fare/0915">Select the 09:15 flight</a></li>
<li>13:30 to 18:05 · 1 stop in Paris · €254 <a href="/fare/1330">Select the 13:30 flight</a></li>
</ul>`,
);

const signIn = (next: string): string =>
  page(
    "Sign in to Aurora Air",
    `<h1>Sign in to hold your fare</h1>
<form method="post" action="/sign-in">
<input type="hidden" name="next" value="${next}">
<label>Email <input id="email" name="email" type="email"></label>
<label>Password <input id="password" name="password" type="password"></label>
<button id="sign-in">Sign in</button>
</form>`,
  );

const PASSENGERS = page(
  "Passenger details",
  `<h1>Passenger details</h1>
<p>Your fare is held for 20 minutes.</p>
<form method="post" action="/passengers">
<label>Full name <input name="name"></label>
<label>Date of birth <input name="born"></label>
<button>Continue to payment</button>
</form>`,
);

const payPage = (passenger: string): string =>
  page(
    "Review and pay",
    `<h1>Review and pay</h1>
<p>Seller: Aurora Air</p>
<p>Passenger: ${passenger}, 1 adult</p>
${ITINERARY}
<p>Total ${PAY_TOTAL} (EUR)</p>
<form method="post" action="/pay">
<label>Card number <input id="card" name="card"></label>
<label>Expiry <input id="expiry" name="expiry"></label>
<label>Security code <input id="code" name="code"></label>
<button id="pay">Pay ${PAY_TOTAL}</button>
</form>`,
  );

const CONFIRMED = page(
  "Booking confirmed",
  `<h1>Booking confirmed</h1>
<p>Reference ${BOOKING_REFERENCE}</p>
<p>London (LHR) to Lisbon (LIS), Sat 18 Oct 07:40 London time, return Sat 25 Oct 18:05 Lisbon time · Sam Rivera · ${PAY_TOTAL} paid</p>
<p>The receipt went to your Aurora Air account email.</p>`,
);

/** The answer to Pay when its confirmation is lost: processing, then unknown. */
const PROCESSING = page(
  "Processing your payment",
  `<h1 id="state">Processing your payment…</h1>
<p id="advice">Do not refresh this page.</p>
<script>
  fetch("/status", { signal: AbortSignal.timeout(1500) }).then(
    () => undefined,
    () => {
      document.getElementById("state").textContent = "We could not confirm your payment";
      document.getElementById("advice").textContent = "Do not pay again. Check My bookings in a few minutes.";
    },
  );
</script>`,
);

const bookings = (confirmed: boolean): string =>
  page(
    "My bookings",
    `<h1>My bookings</h1>${
      confirmed
        ? `<p>${BOOKING_REFERENCE} · London to Lisbon, Sat 18 Oct to Sat 25 Oct · Sam Rivera</p>`
        : "<p>No bookings yet. A payment may still be processing.</p>"
    }`,
  );

function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => resolve(new URLSearchParams(body)));
  });
}

function sessionOf(request: IncomingMessage): string | undefined {
  return /(?:^|;\s*)aurora=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
}

/**
 * Start Aurora Air. `guest` lets a payment be made with no sign-in and a
 * passenger already named; `lose` loses the payment's confirmation.
 */
export async function startFakeAirline(
  options: { guest?: boolean; lose?: boolean } = {},
): Promise<FakeAirline> {
  const sessions = new Set<string>();
  const passengers = new Map<string, string>();
  const payments: FakeAirline["payments"] = [];
  const held: ServerResponse[] = [];
  const send = (response: ServerResponse, html: string, status = 200): void => {
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      // A payment's pages are never kept, as a real airline's are not.
      "cache-control": "no-store",
    });
    response.end(html);
  };
  const go = (response: ServerResponse, to: string, cookie?: string): void => {
    response.writeHead(303, { location: to, ...(cookie ? { "set-cookie": cookie } : {}) });
    response.end();
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://aurora.localhost");
    const session = sessionOf(request);
    const signedIn = options.guest === true || (session !== undefined && sessions.has(session));
    if (request.method === "POST" && url.pathname === "/sign-in") {
      const form = await readForm(request);
      const id = randomUUID();
      sessions.add(id);
      go(response, form.get("next") || "/", `aurora=${id}; Path=/; HttpOnly; SameSite=Lax`);
      return;
    }
    if (request.method === "POST" && url.pathname === "/passengers") {
      const form = await readForm(request);
      passengers.set(session ?? "guest", form.get("name") ?? "");
      go(response, "/pay");
      return;
    }
    if (request.method === "POST" && url.pathname === "/pay") {
      const form = await readForm(request);
      payments.push({ total: PAY_TOTAL, card: form.get("card") ?? "" });
      send(response, options.lose ? PROCESSING : CONFIRMED);
      return;
    }
    if (url.pathname === "/status") {
      // The lost answer: the airline's confirmation never comes.
      held.push(response);
      return;
    }
    if (url.pathname === "/") return send(response, SEARCH);
    if (url.pathname === "/bookings") {
      return signedIn
        ? send(response, bookings(!options.lose && payments.length > 0))
        : send(response, signIn("/bookings"));
    }
    if (url.pathname.startsWith("/fare/")) {
      return signedIn ? send(response, PASSENGERS) : go(response, `/sign-in?next=${url.pathname}`);
    }
    if (url.pathname === "/sign-in")
      return send(response, signIn(url.searchParams.get("next") ?? "/"));
    if (url.pathname === "/pay") {
      if (!signedIn) return go(response, "/sign-in?next=/pay");
      return send(response, payPage(passengers.get(session ?? "guest") || "Sam Rivera"));
    }
    send(response, page("Not found", "<h1>Not found</h1>"), 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${AIRLINE_HOST}:${port}/`,
    site: `${AIRLINE_HOST}:${port}`,
    payments,
    close: async () => {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
