import { afterEach, describe, expect, it } from "vitest";
import {
  type GoogleStandIn,
  STAND_IN_CLIENT_ID,
  STAND_IN_CLIENT_SECRET,
  startGoogleStandIn,
} from "../../tests/helpers/googleStandIn";
import { GOOGLE_SCOPES, googleSetup } from "./integrations/providers/google/client";
import { type GoogleIssued, signInOnLoopback } from "./integrations/providers/google/signIn";
import { returnPath, SIGN_IN_RETURN_WORDS, SignInReturns } from "./signInReturns";

/**
 * INF-3454's plan, the captain's answer direction=catch-here: a Google
 * sign-in waiting on the first mate's computer takes the browser's return
 * from another computer, handed only to the port it listens on, once, and
 * only while it waits. The waiting sign-in is the real one, against the
 * test-only stand-in Google; the browser on the other computer is the test.
 */

let google: GoogleStandIn | undefined;
afterEach(async () => {
  await google?.close();
  google = undefined;
});

/** A real Google sign-in waiting here, whose page "opens" by registering its return. */
async function waitingSignIn(returns: SignInReturns) {
  google = await startGoogleStandIn();
  const setup = googleSetup({
    packaged: false,
    env: {
      INFINITARY_GOOGLE_CLIENT_ID: STAND_IN_CLIENT_ID,
      INFINITARY_GOOGLE_CLIENT_SECRET: STAND_IN_CLIENT_SECRET,
      INFINITARY_GOOGLE_URL: google.base,
    },
  });
  if (!setup.client) throw new Error("a run that names a client has one");
  const cancel = new AbortController();
  let opened: (page: { url: string; id: string; port: number }) => void = () => {};
  const page = new Promise<{ url: string; id: string; port: number }>((resolve) => {
    opened = resolve;
  });
  const signedIn: Promise<GoogleIssued> = signInOnLoopback({
    ...setup,
    client: setup.client,
    scopes: GOOGLE_SCOPES,
    open: async (url, to) => opened({ url, id: returns.open(to), port: to.port }),
    signal: cancel.signal,
    now: () => Date.UTC(2026, 10, 9, 18),
  });
  signedIn.catch(() => {});
  const shown = await page;
  // The person approves on Google's page; their browser is sent back to this address.
  const consent = await fetch(shown.url, { redirect: "manual" });
  const back = consent.headers.get("location") ?? "";
  return { ...shown, back, signedIn, cancel };
}

describe("a sign-in's return from another computer", () => {
  it("hands the browser's return to the waiting sign-in once, and its page back", async () => {
    const returns = new SignInReturns();
    const waiting = await waitingSignIn(returns);
    const back = new URL(waiting.back);
    expect(back.port).toBe(String(waiting.port));

    // Something else that reaches the listener is turned away and spends nothing.
    const stray = await returns.deliver(waiting.id, "/?state=not-this-one&code=4/0Aan");
    expect(stray.status).toBe(404);
    expect(returns.waits(waiting.id)).toBe(true);

    // What the browser on the other computer asked, as its path.
    const answer = await returns.deliver(waiting.id, `${back.pathname}${back.search}`);
    expect(answer.status).toBe(200);
    expect(answer.page).toContain("Signed in to Google");
    expect((await waiting.signedIn).refreshToken).toBeTruthy();

    // Once only: the id is spent, and the sign-in has ended.
    await expect(returns.deliver(waiting.id, waiting.back)).rejects.toThrow(
      SIGN_IN_RETURN_WORDS.gone,
    );
  });

  it("takes a pasted address at its path alone, never its host or port", async () => {
    const returns = new SignInReturns();
    const waiting = await waitingSignIn(returns);
    const back = new URL(waiting.back);
    // The same return, written for another port: only the waiting sign-in's port is reached.
    const elsewhere = `http://localhost:1${back.pathname}${back.search}`;
    const answer = await returns.deliver(waiting.id, ` ${elsewhere} `);
    expect(answer.status).toBe(200);
    await waiting.signedIn;
  });

  it("refuses a return once the sign-in stopped waiting, and an address that is not a return", async () => {
    const returns = new SignInReturns();
    const waiting = await waitingSignIn(returns);
    await expect(returns.deliver(waiting.id, "https://example.com/?code=4")).rejects.toThrow(
      SIGN_IN_RETURN_WORDS.notAnAddress,
    );
    await expect(returns.deliver(waiting.id, "not an address")).rejects.toThrow(
      SIGN_IN_RETURN_WORDS.notAnAddress,
    );
    waiting.cancel.abort();
    await expect(waiting.signedIn).rejects.toThrow("cancelled");
    expect(returns.waits(waiting.id)).toBe(false);
    await expect(returns.deliver(waiting.id, waiting.back)).rejects.toThrow(
      SIGN_IN_RETURN_WORDS.gone,
    );
    await expect(returns.deliver("never-opened", waiting.back)).rejects.toThrow(
      SIGN_IN_RETURN_WORDS.gone,
    );
  });

  it("reads a path from a browser's request or a pasted loopback address", () => {
    expect(returnPath("/?state=s&code=c")).toBe("/?state=s&code=c");
    expect(returnPath("http://127.0.0.1:53817/?state=s&code=c")).toBe("/?state=s&code=c");
    expect(() => returnPath("//evil.example/?code=c")).toThrow(SIGN_IN_RETURN_WORDS.notAnAddress);
  });
});
