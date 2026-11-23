import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as m from "@shared/i18n/messages.generated";
import { CODEX_SAVED_RESET_FLOOR, type SavedResetResult } from "@shared/savedResets";
import type { AuthInteractionBridge } from "../pi/piAuth";
import { CodexAppServer, CodexRefusal, CodexUnanswered, type StartCodexProcess } from "./appServer";
import type { CodexCliCheck } from "./codexCli";

/**
 * Using one of a Codex account's saved resets (docs/codex-client.md): the
 * installed Codex CLI's app-server, with its home in the account's own
 * folder, signs in as that ChatGPT account with Codex's own sign-in the
 * first time, checks it is the same account Infinitary's sign-in names,
 * and uses the saved reset that expires first.
 *
 * A used reset cannot be given back, so each attempt's key is saved before
 * it is sent and sent again after any answer that is not clear, which
 * Codex's request treats as the same attempt; only a clear outcome clears
 * it. Nothing here reads or keeps a token.
 */

/** How long one request may go unanswered before its outcome counts as unknown. */
const ANSWER_WITHIN_MS = 60_000;

/** How long a sign-in waits for the browser when nothing stops it sooner. */
const SIGN_IN_WITHIN_MS = 15 * 60_000;

/** Where a person uses a saved reset without Infinitary. */
const RESET_SITE = "chatgpt.com";

/** One attempt to use a reset, kept on the account until Codex answers it clearly. */
export type SavedResetAttempt = { key: string; creditId?: string };

export type SavedResetReach = {
  /** This computer's Codex CLI, looked for and read again for each use. */
  check: () => Promise<CodexCliCheck>;
  /** The account's Codex home, created if it is missing; only the account's store writes it. */
  home: (accountId: string) => string;
  /** The ChatGPT account id Infinitary's own sign-in for this account names, when it can say. */
  ownAccountId: (accountId: string) => Promise<string | undefined>;
  attempt: {
    read: (accountId: string) => SavedResetAttempt | undefined;
    save: (accountId: string, attempt: SavedResetAttempt) => void;
    clear: (accountId: string) => void;
  };
  /** Infinitary's own version, as it greets Codex. */
  version: string;
  start?: StartCodexProcess;
};

export type SavedResetUse = {
  accountId: string;
  /** The account's provider, which the sign-in's link and prompt name. */
  providerId: string;
  /** The account as words name it ("Codex · Work"). */
  account: string;
  /**
   * Where the sign-in is shown, when Codex may start one; absent, an
   * account Codex is not signed in to is refused with where to sign in.
   */
  bridge?: AuthInteractionBridge;
};

type Account = { type?: string } | null;
type RateLimits = {
  accountId?: string | null;
  rateLimitResetCredits?: {
    availableCount?: number | string;
    credits?: { id: string; status: string; expiresAt: number | null }[] | null;
  } | null;
};

/**
 * Codex failing before the reset is asked for: nothing was used, so the
 * words say so, with Codex's own reason when it gave one.
 */
function codexStopped(error: unknown): never {
  if (error instanceof CodexRefusal)
    throw new Error(`${m.accountsSavedResetCodexStopped()} ${error.message}`);
  if (error instanceof CodexUnanswered) throw new Error(m.accountsSavedResetCodexStopped());
  throw error;
}

/**
 * The Codex homes a use runs in now, on this computer. One use at a time per
 * account: two would each start Codex in one home, could send two keys and
 * spend two resets, and could renew one sign-in twice at once.
 */
const usingHomes = new Set<string>();

/** Uses one saved reset of the account, or throws words that say why not. */
export async function redeemSavedReset(
  reach: SavedResetReach,
  use: SavedResetUse,
): Promise<SavedResetResult> {
  return inHome(reach, use, (home) => redeemIn(home, reach, use));
}

/**
 * Signs Codex in as the account when it keeps no sign-in for it yet, and
 * checks it is the same ChatGPT account, using nothing: what turning on
 * Use saved resets on their own asks first (docs/quota.md, "Saved resets
 * on their own"). Without a bridge, an account Codex is not signed in to is
 * refused with words saying where to sign in.
 */
export async function signInForSavedResets(
  reach: SavedResetReach,
  use: SavedResetUse,
): Promise<void> {
  await inHome(reach, use, async (home) => {
    const { server } = await openVerified(home, reach, use);
    server.close();
  });
}

/** Runs one use in the account's Codex home, refusing a second while one runs there. */
async function inHome<T>(
  reach: SavedResetReach,
  use: SavedResetUse,
  work: (home: string) => Promise<T>,
): Promise<T> {
  const home = reach.home(use.accountId);
  if (usingHomes.has(home)) throw new Error(m.accountsSavedResetBusy({ account: use.account }));
  usingHomes.add(home);
  try {
    return await work(home);
  } finally {
    usingHomes.delete(home);
  }
}

/**
 * Starts Codex in the account's home, signed in as the same ChatGPT account
 * Infinitary's own sign-in names, with its allowance as Codex read it. The
 * caller closes the server; a refusal closes it here.
 */
async function openVerified(
  home: string,
  reach: SavedResetReach,
  use: SavedResetUse,
): Promise<{ server: CodexAppServer; limits: RateLimits }> {
  const cli = await reach.check();
  if (cli.state === "missing")
    throw new Error(
      m.accountsSavedResetNoCodex({ floor: CODEX_SAVED_RESET_FLOOR, site: RESET_SITE }),
    );
  if (cli.state === "old")
    throw new Error(
      m.accountsSavedResetOldCodex({
        floor: CODEX_SAVED_RESET_FLOOR,
        version: cli.version,
        site: RESET_SITE,
      }),
    );
  const server = await CodexAppServer.start({
    executable: cli.executable,
    home,
    version: reach.version,
    answerWithinMs: ANSWER_WITHIN_MS,
    ...(reach.start ? { start: reach.start } : {}),
  }).catch(codexStopped);
  try {
    const read = await server
      .request<{ account: Account }>("account/read", { refreshToken: false }, ANSWER_WITHIN_MS)
      .catch(codexStopped);
    const signedIn = read.account?.type === "chatgpt";
    if (!signedIn) {
      if (!use.bridge) throw new Error(m.accountsSavedResetSignInFirst({ account: use.account }));
      await signIn(server, use, use.bridge);
    }
    const readLimits = () =>
      server.request<RateLimits>("account/rateLimits/read", {}, ANSWER_WITHIN_MS);
    const limits = await readLimits().catch(async (error: unknown) => {
      // Codex refusing the read with a sign-in kept from before may mean that
      // sign-in stopped working, or only that the read failed (offline, an
      // outage). Only Settings, where a sign-in is shown, signs Codex out and
      // in again; a card's or the first mate's use keeps the sign-in and says
      // Codex's reason.
      if (!signedIn || !(error instanceof CodexRefusal)) return codexStopped(error);
      if (!use.bridge)
        throw new Error(
          `${m.accountsSavedResetSignInAgain({ account: use.account })} ${error.message}`,
        );
      await server.request("account/logout", undefined, ANSWER_WITHIN_MS).catch(() => undefined);
      await signIn(server, use, use.bridge);
      return readLimits().catch(codexStopped);
    });
    const theirs = limits.accountId ?? signedInAccountId(home);
    const ours = await reach.ownAccountId(use.accountId);
    if (!theirs || !ours) throw new Error(m.accountsSavedResetUnverified({ account: use.account }));
    if (theirs !== ours) {
      await server.request("account/logout", undefined, ANSWER_WITHIN_MS).catch(() => undefined);
      throw new Error(m.accountsSavedResetOtherAccount({ account: use.account }));
    }
    return { server, limits };
  } catch (error) {
    server.close();
    throw error;
  }
}

async function redeemIn(
  home: string,
  reach: SavedResetReach,
  use: SavedResetUse,
): Promise<SavedResetResult> {
  const { server, limits } = await openVerified(home, reach, use);
  try {
    const kept = reach.attempt.read(use.accountId);
    const summary = limits.rateLimitResetCredits ?? undefined;
    if (!kept && summary && countOf(summary.availableCount) === 0)
      return { outcome: "none-left", left: 0 };
    const creditId = earliestExpiring(summary?.credits ?? []);
    const attempt: SavedResetAttempt = kept ?? {
      key: randomUUID(),
      ...(creditId ? { creditId } : {}),
    };
    // Kept before it is sent: a lost answer is asked again under the same key.
    if (!kept) reach.attempt.save(use.accountId, attempt);
    let outcome: string;
    try {
      ({ outcome } = await server.request<{ outcome: string }>(
        "account/rateLimitResetCredit/consume",
        { idempotencyKey: attempt.key, creditId: attempt.creditId ?? null },
        ANSWER_WITHIN_MS,
      ));
    } catch (error) {
      const said = error instanceof CodexRefusal ? ` ${error.message}` : "";
      throw new Error(`${m.accountsSavedResetUnclear({ account: use.account })}${said}`);
    }
    const result = resultOf(outcome);
    if (!result) throw new Error(m.accountsSavedResetUnclear({ account: use.account }));
    reach.attempt.clear(use.accountId);
    if (result.outcome !== "used") return result;
    const after = await server
      .request<RateLimits>("account/rateLimits/read", {}, ANSWER_WITHIN_MS)
      .catch(() => undefined);
    const left = countOf(after?.rateLimitResetCredits?.availableCount);
    return { outcome: "used", ...(left !== undefined ? { left } : {}) };
  } finally {
    server.close();
  }
}

/**
 * Signs Codex in as the account, with Codex's own ChatGPT sign-in: its page
 * opens in the browser and the link is shown, and the address the browser
 * ends on can be pasted back, which reaches Codex's own sign-in on this
 * computer as the browser would have. That is how a computer that runs work
 * signs in when the browser is on the captain's screen.
 */
async function signIn(
  server: CodexAppServer,
  use: SavedResetUse,
  bridge: AuthInteractionBridge,
): Promise<void> {
  const login = await server
    .request<{ type: string; loginId?: string; authUrl?: string }>(
      "account/login/start",
      { type: "chatgpt" },
      ANSWER_WITHIN_MS,
    )
    .catch(codexStopped);
  const { loginId, authUrl } = login;
  if (login.type !== "chatgpt" || !loginId || !authUrl)
    throw new Error(m.accountsSavedResetSignInFailed());
  let done = false;
  const cleanups: (() => void)[] = [];
  const finished = new Promise<void>((resolve, reject) => {
    cleanups.push(
      server.onNotification((method, params) => {
        if (method !== "account/login/completed") return;
        const completed = params as {
          loginId?: string | null;
          success?: boolean;
          error?: string | null;
        };
        if (completed.loginId && completed.loginId !== loginId) return;
        if (completed.success) resolve();
        else
          reject(
            new Error(
              `${m.accountsSavedResetSignInFailed()}${completed.error ? ` ${completed.error}` : ""}`,
            ),
          );
      }),
    );
    const timer = setTimeout(
      () => reject(new Error(m.accountsSavedResetSignInFailed())),
      SIGN_IN_WITHIN_MS,
    );
    cleanups.push(() => clearTimeout(timer));
    const cancel = () => {
      void server.request("account/login/cancel", { loginId }, ANSWER_WITHIN_MS).catch(() => {});
      reject(new Error("Sign in cancelled"));
    };
    if (bridge.signal?.aborted) cancel();
    bridge.signal?.addEventListener("abort", cancel, { once: true });
    cleanups.push(() => bridge.signal?.removeEventListener("abort", cancel));
  });
  bridge.notify({
    providerId: use.providerId,
    accountId: use.accountId,
    kind: "auth_url",
    message: m.accountsSavedResetSignInNotice({ account: use.account }),
    url: authUrl,
  });
  void bridge.openExternal(authUrl).catch(() => {});
  const redirect = loopbackRedirect(authUrl);
  if (redirect) void pasteBack(bridge, use, redirect, () => done);
  try {
    await finished;
  } finally {
    done = true;
    for (const cleanup of cleanups) cleanup();
  }
}

/**
 * Asks for the address the browser ended on until the sign-in ends, and
 * sends what the browser would have sent to Codex's own sign-in on this
 * computer. A pasted address without the sign-in's code asks again.
 */
async function pasteBack(
  bridge: AuthInteractionBridge,
  use: SavedResetUse,
  redirect: URL,
  done: () => boolean,
): Promise<void> {
  let message = m.accountsSavedResetPastePrompt();
  while (!done()) {
    let pasted: string;
    try {
      pasted = await bridge.prompt({
        promptId: randomUUID(),
        providerId: use.providerId,
        accountId: use.accountId,
        kind: "manual_code",
        message,
        placeholder: m.accountsSavedResetPastePlaceholder(),
      });
    } catch {
      return;
    }
    if (done()) return;
    const target = callbackFor(redirect, pasted);
    if (!target) {
      message = m.accountsSavedResetPasteAgain();
      continue;
    }
    // Codex's own page answers; how the sign-in ended arrives from Codex itself.
    await fetch(target, { redirect: "manual" }).catch(() => undefined);
    return;
  }
}

/** The sign-in page's return address, when it is Codex's own on this computer. */
export function loopbackRedirect(authUrl: string): URL | undefined {
  try {
    const raw = new URL(authUrl).searchParams.get("redirect_uri");
    if (!raw) return undefined;
    const redirect = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
    return redirect.protocol === "http:" && loopback ? redirect : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The address to send Codex's sign-in on this computer for a pasted one:
 * its return address with the pasted address's query, which must carry the
 * sign-in's `code` and `state`. Undefined for anything else.
 */
export function callbackFor(redirect: URL, pasted: string): string | undefined {
  const text = pasted.trim();
  let query: URLSearchParams;
  try {
    query = text.includes("://")
      ? new URL(text).searchParams
      : new URLSearchParams(text.replace(/^[^?]*\?/, ""));
  } catch {
    return undefined;
  }
  if (!query.get("code") || !query.get("state")) return undefined;
  const target = new URL(redirect.toString());
  target.search = query.toString();
  return target.toString();
}

export function earliestExpiring(
  credits: readonly { id: string; status: string; expiresAt: number | null }[],
): string | undefined {
  return credits
    .filter((credit) => credit.status === "available")
    .sort(
      (a, b) =>
        (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY),
    )[0]?.id;
}

function resultOf(outcome: string): SavedResetResult | undefined {
  if (outcome === "reset" || outcome === "alreadyRedeemed") return { outcome: "used" };
  if (outcome === "nothingToReset") return { outcome: "nothing-to-reset" };
  if (outcome === "noCredit") return { outcome: "none-left" };
  return undefined;
}

function countOf(value: unknown): number | undefined {
  const count = typeof value === "string" ? Number(value) : value;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : undefined;
}

/**
 * The ChatGPT account id Codex's own sign-in file names, for a Codex whose
 * allowance answer leaves it out. Only that id is read, never a token.
 */
function signedInAccountId(home: string): string | undefined {
  try {
    const auth = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as {
      tokens?: { account_id?: unknown };
    };
    return typeof auth.tokens?.account_id === "string" ? auth.tokens.account_id : undefined;
  } catch {
    return undefined;
  }
}
