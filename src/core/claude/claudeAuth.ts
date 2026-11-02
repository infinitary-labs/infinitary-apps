import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MachineLoginOutcome } from "@shared/accounts";
import { CLAUDE_CHIP_INSTALL_NOTE, CLAUDE_CLIENT_MISSING_TEXT } from "@shared/claudeClient";
import { HERE } from "@shared/deviceNames";
import {
  type AccountBackend,
  type AccountBinding,
  type AccountLoginRequest,
  type AccountRef,
  type AccountStatus,
  type LogoutOutcome,
  statusFromHealth,
} from "../accounts/accountBackend";
import {
  CREDENTIAL_RENEW_LEAD_MS,
  type CredentialHealth,
  type CredentialStamp,
  classifyExpiry,
  type RenewalOutcome,
  type RenewReason,
} from "../accounts/credentialHealth";
import { absentKeychain, type HostKeychain } from "../host";
import {
  type ClaudeClientCheck,
  checkClaudeClient,
  claudeClientIssueReason,
  claudeClientIssueText,
  LOGIN_TIMEOUT_MS,
  NO_BROWSER,
  pasteCodeLink,
  type RunClaude,
  resolveClaudeExecutable,
  runClaude,
} from "./claudeCli";
import {
  type ClaudeCredentialEvidence,
  type ClaudeQuotaAuthResult,
  clearClaudeCredentialCache,
  clearKeychainLock,
  defaultClaudeConfigDir,
  readClaudeCredentialEvidence,
  readClaudeCredentialStamp,
  renewClaudeQuotaAuth,
  requestKeychainValueAccess,
  resolveClaudeQuotaAuthResult,
} from "./claudeQuota";
import { runExclusiveStoreTask, tryExclusiveStoreTask } from "./claudeStoreLease";

/**
 * The Claude account backend (account-broker phase 7, CD-1=B). One Claude
 * account, ever: Infinitary reads the machine's default `claude login` and never
 * mints or refreshes Anthropic OAuth. The vault still keeps a bookkeeping
 * directory per account row; that directory is not CLAUDE_CONFIG_DIR and is
 * not a credential store. Login, status, quota and crewmate runs all target
 * the vendor's own default store (`~/.claude` + the bare Keychain item).
 *
 * The client those runs spawn is the one installed on the machine (F14):
 * Infinitary ships none. A missing or too-old client is a fact about the
 * account, not about its credential - the health carries it as
 * `client_missing` / `client_outdated` with the one sentence to show, the
 * credential is still never a sign-out, and the account serves no model
 * until the client is there (`src/shared/claudeClient.ts`).
 *
 * Removing the Infinitary account does not run `claude auth logout` - that would
 * sign the user out of Claude Code. Disconnect is unbind only, but for one
 * login: the one Firstmate made on a computer that runs work from a code the
 * captain pasted (`pasteCode`), which it records when it makes it
 * (`MADE_LOGIN_FILE`) and signs out again (`signOutMadeLogin`).
 */

/**
 * The record a sign-in with a pasted code keeps in the account's own folder:
 * Firstmate made the login on this Mac, and which login it was (the stamp's
 * digest of its account and organisation, never a token). An adopted login
 * has none, so nothing ever signs it out.
 */
export const MADE_LOGIN_FILE = "made-login.json";

type MadeLogin = { version: 1; login?: string; at: number };

/** The record at `file`, or null when there is none or it cannot be read. */
export function readMadeLogin(file: string): MadeLogin | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const { version, login, at } = parsed as Record<string, unknown>;
    if (version !== 1 || typeof at !== "number") return null;
    return typeof login === "string" ? { version, login, at } : { version, at };
  } catch {
    return null;
  }
}

/**
 * Sign in over a store that could not be read: Infinitary starts no new sign-in
 * that could replace a login it cannot see.
 */
export const CLAUDE_LOGIN_UNREADABLE_TEXT = `Infinitary couldn't read the Claude login on ${HERE.this}, so it didn't start a new sign-in over it. Try again - if it keeps happening, quit Infinitary and open it from the Dock.`;

/**
 * The same refusal on a computer that runs work (`pasteCode`), read at its
 * home under that computer's sign-in: the login is there, not on the Mac
 * the captain reads it on.
 */
export const CLAUDE_LOGIN_UNREADABLE_THERE_TEXT =
  "Infinitary couldn't read the Claude login there, so it didn't start a new sign-in over it. Try again.";

/**
 * A sign-in that ended without Claude saying why. The browser page can say
 * the person is set up even then. The sentence names Claude's failure and
 * the login the person can finish in Claude Code, which we then use.
 */
export const CLAUDE_LOGIN_UNFINISHED_TEXT =
  "Claude failed to sign in. Open Terminal, start the Claude Code CLI, and run /login. Then connect Claude here again.";

/** The same on a computer that runs work (`pasteCode`), read at its home. */
export const CLAUDE_LOGIN_UNFINISHED_THERE_TEXT =
  "Claude failed to sign in there. On that computer, start the Claude Code CLI and run /login. Then try again.";

export type ClaudeAuthBackendOptions = {
  /** Injectable for tests; production spawns the real client. */
  run?: RunClaude;
  /** Injectable for tests; production looks for the installed executable. */
  available?: () => boolean;
  /**
   * Injectable for tests; production runs `checkClaudeClient` (the installed
   * client and its version against the SDK's floor). A test that injects
   * only `available` gets a client that counts as ready.
   */
  client?: () => Promise<ClaudeClientCheck>;
  /** Injectable for tests; production reads the machine's default login. */
  evidence?: (configDir: string) => Promise<ClaudeCredentialEvidence>;
  /**
   * Injectable for tests; production reads the default login's stamp from
   * attributes (`readClaudeCredentialStamp`). A test that injects only
   * `evidence` gets no stamp, so no unit test reads the developer's login.
   */
  stamp?: (configDir: string) => Promise<CredentialStamp>;
  /**
   * Request the Keychain VALUE at sign-in. Production does the real read
   * through the host capability (which may raise the one macOS ask);
   * tests inject a no-op or a spy.
   */
  primeKeychain?: (configDir: string) => Promise<void>;
  /**
   * Host Keychain seam. Production passes `host.keychain` so the grant is
   * Infinitary's. Tests that spy on `primeKeychain` can omit this.
   */
  keychain?: HostKeychain;
  /**
   * The vendor's default config root. Production is `~/.claude`; tests pass
   * a throwaway dir so they never touch the developer's login.
   */
  configDir?: () => string;
  /** Injectable clock for expiry classification; production is `Date.now`. */
  now?: () => number;
  /** Proactive-renew lead; tests pass a smaller window. */
  leadMs?: number;
  /**
   * Sign in with a code pasted back, and open no browser here: a computer
   * that runs work for another Mac, where a browser would open on a screen
   * nobody watches (docs/helper.md, "Its own sign-ins"). A login already
   * here is adopted as ever; with none, the vendor's own login runs with
   * its browser opener stubbed, its link goes to the bridge, and the code
   * its page shows comes back as the answer to a prompt, onto the client's
   * stdin. A lookup miss is confirmed with the client before that sign-in
   * starts: nobody at that screen would see one replaced.
   */
  pasteCode?: boolean;
};

export class ClaudeAuthBackend implements AccountBackend {
  readonly id = "claude" as const;
  private readonly run: RunClaude;
  private readonly available: () => boolean;
  private readonly client: () => Promise<ClaudeClientCheck>;
  private readonly evidence: (configDir: string) => Promise<ClaudeCredentialEvidence>;
  private readonly stamp: (configDir: string) => Promise<CredentialStamp>;
  private readonly primeKeychain: (configDir: string) => Promise<void>;
  private readonly configDir: () => string;
  private readonly keychain: HostKeychain;
  private readonly now: () => number;
  private readonly leadMs: number;
  private readonly pasteCode: boolean;

  constructor(options: ClaudeAuthBackendOptions = {}) {
    const keychain = options.keychain ?? absentKeychain;
    this.keychain = keychain;
    this.run = options.run ?? runClaude;
    this.available = options.available ?? (() => resolveClaudeExecutable() !== undefined);
    // An injected `available` is a test's stand-in for the client PROBE, not
    // for the install: with it and no `client`, the client counts as fine so
    // no unit test ever spawns the developer's real Claude Code. The product
    // injects neither and checks the machine.
    this.client =
      options.client ??
      (options.available
        ? async () => ({ state: "ready", executable: "injected" })
        : () => checkClaudeClient());
    this.evidence = options.evidence ?? ((dir) => readClaudeCredentialEvidence(dir, { keychain }));
    this.stamp =
      options.stamp ??
      (options.evidence ? async () => ({}) : (dir) => readClaudeCredentialStamp(dir, { keychain }));
    this.primeKeychain =
      options.primeKeychain ??
      (async (dir) => {
        await requestKeychainValueAccess(dir, { keychain });
      });
    this.configDir = options.configDir ?? defaultClaudeConfigDir;
    this.now = options.now ?? Date.now;
    this.leadMs = options.leadMs ?? CREDENTIAL_RENEW_LEAD_MS;
    this.pasteCode = options.pasteCode ?? false;
  }

  /**
   * A Claude subscription signs in through Claude itself. There is no
   * key-paste path here on purpose: this backend exists to reach the
   * subscription, and a console key is a different product on a different
   * bill.
   */
  authTypes(): ("oauth" | "api_key")[] {
    return this.available() ? ["oauth"] : [];
  }

  /** No client on this Mac (F14): the chip stays, disabled, and says so. */
  unavailable(): { note: string; detail: string } | undefined {
    return this.available()
      ? undefined
      : { note: CLAUDE_CHIP_INSTALL_NOTE, detail: CLAUDE_CLIENT_MISSING_TEXT };
  }

  /**
   * Attach the machine's default Claude login. If it is already signed in,
   * we adopt it with no browser bounce. A replacement sign-in runs the
   * vendor's own `claude auth login` with CLAUDE_CONFIG_DIR unset so it
   * writes the everyday item - not a private Infinitary store.
   *
   * That replacement starts only from current, consistent evidence that a
   * new login is needed, decided under the store lease after any wait. A
   * lookup miss is not a sign-out until the client says it is signed out. A
   * store we cannot read, or one that becomes unreadable while we wait, is
   * adopted only on the client's own word that it is signed in, and otherwise
   * refused in a sentence - a new vendor sign-in replaces the stored login
   * and can sign out every Claude Code session already running. A refresh
   * token that has lapsed in both stores still starts the sign-in, unless
   * the client says it is signed in.
   */
  async login(request: AccountLoginRequest): Promise<void> {
    if (request.type !== "oauth") {
      throw new Error("A Claude subscription signs in through Claude, not with a key.");
    }
    // No client, no account: the sentence says what to do (F14). An
    // existing machine login changes nothing here - nothing could run it.
    const issue = claudeClientIssueText(await this.client());
    if (issue) throw new Error(issue);
    const dir = this.configDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (this.pasteCode) {
      await this.loginWithPastedCode(request, dir);
      return;
    }
    await this.loginWithBrowser(request, dir);
  }

  /**
   * Adopt, start a replacement, or refuse, from the store as it is now.
   * Caller holds the exclusive store lease, so the status read is the
   * already-held one: a nested lease would defer and look like no answer.
   */
  private async replacementDecision(dir: string): Promise<"adopt" | "login" | "refuse"> {
    const evidence = await this.evidence(dir);
    if (evidence.state === "live") return "adopt";
    const word = await this.statusNow(dir);
    if (word?.connected === true) return "adopt";
    // The status read can rewrite the store, and a wait can change what we
    // could not read. Only the reading after that is current.
    const again = await this.evidence(dir);
    if (again.state === "live") return "adopt";
    if (again.state === "unknown") return "refuse";
    if (again.state === "absent" && word?.connected === false) return "login";
    return "refuse";
  }

  /**
   * The vendor's own login on this computer. The client opens the browser.
   * The link it prints is kept, so the person can open that page again, and
   * a code the page shows can be pasted back: stdin stays open for that,
   * and cancelling the prompt stops the client. The whole wait, including
   * time spent behind another sign-in, is the one five-minute bound.
   *
   * A sign-in already waiting re-reads the store once it holds the lease.
   * If the one in front saved a login, this one adopts it and starts no
   * second browser login. The vendor sends a failed token exchange to the
   * same page as success; that page is not the sign-in, and a run that
   * stops after saving a login is still a saved login.
   */
  private async loginWithBrowser(request: AccountLoginRequest, dir: string): Promise<void> {
    const started = Date.now();
    const { bridge } = request;
    let pasted: (code: string) => void = () => {};
    let stopped: (reason: unknown) => void = () => {};
    const paste = new Promise<string>((resolve, reject) => {
      pasted = resolve;
      stopped = reject;
    });
    // A paste the run never waited for (it ended first) is nobody's failure.
    paste.catch(() => {});
    const stop = () => stopped(new Error("Sign in cancelled"));
    bridge.signal?.addEventListener("abort", stop, { once: true });
    let output = "";
    let asked = false;
    const timedOut = () => new Error("Claude did not respond in time.");
    try {
      let outcome:
        | { kind: "adopt" }
        | { kind: "refuse" }
        | { kind: "ran"; ran: Awaited<ReturnType<RunClaude>> };
      try {
        outcome = await runExclusiveStoreTask(dir, async () => {
          const remaining = LOGIN_TIMEOUT_MS - (Date.now() - started);
          if (remaining <= 0) throw timedOut();
          const decision = await this.replacementDecision(dir);
          if (decision === "adopt") return { kind: "adopt" as const };
          if (decision === "refuse") return { kind: "refuse" as const };
          const left = LOGIN_TIMEOUT_MS - (Date.now() - started);
          if (left <= 0) throw timedOut();
          bridge.notify({
            providerId: request.providerId,
            accountId: request.accountId,
            kind: "progress",
            message: "Opening Claude in your browser to sign in...",
          });
          const ran = await this.run(["auth", "login", "--claudeai"], dir, {
            timeoutMs: left,
            paste,
            onStdout: (chunk) => {
              output += chunk;
              if (asked) return;
              const link = pasteCodeLink(output);
              if (!link) return;
              asked = true;
              bridge.notify({
                providerId: request.providerId,
                accountId: request.accountId,
                kind: "auth_url",
                message: "Finish signing in with your browser, then come back here.",
                url: link,
              });
              bridge
                .prompt({
                  promptId: randomUUID(),
                  providerId: request.providerId,
                  accountId: request.accountId,
                  kind: "manual_code",
                  message: "Paste the code the page shows, if it asks for one.",
                  placeholder: "paste the code",
                })
                .then(pasted, stopped);
            },
          });
          return { kind: "ran" as const, ran };
        });
      } catch (caught) {
        // A client we stopped may already have saved the login. The store,
        // not the thrown timer, says whether this sign-in finished.
        if (await this.savedLogin(request)) {
          try {
            await this.primeKeychain(dir);
          } catch {
            // The account is connected; the meter will say why usage cannot be read.
          }
          return;
        }
        throw caught;
      }
      if (outcome.kind === "adopt") {
        await this.finishAdopted(request, dir);
        return;
      }
      if (outcome.kind === "refuse") {
        throw new Error(CLAUDE_LOGIN_UNREADABLE_TEXT);
      }
      // The store is the authority, not the exit code, and not the page the
      // vendor showed. A failed exchange still redirects there.
      if (!(await this.savedLogin(request))) {
        throw new Error(
          loginFailure(outcome.ran.stderr, outcome.ran.stdout, CLAUDE_LOGIN_UNFINISHED_TEXT),
        );
      }
      // Sign-in is the moment a permission prompt is expected (D-3). A
      // refused value read is a meter failure, not a failed sign-in.
      try {
        await this.primeKeychain(dir);
      } catch {
        // The account is connected; the meter will say why usage cannot be read.
      }
    } finally {
      bridge.signal?.removeEventListener("abort", stop);
      stop();
    }
  }

  /** The machine login is already here: say so, and do not open a browser. */
  private async finishAdopted(request: AccountLoginRequest, dir: string): Promise<void> {
    request.bridge.notify({
      providerId: request.providerId,
      accountId: request.accountId,
      kind: "info",
      message: `Using the Claude login on ${HERE.this}.`,
    });
    try {
      await this.primeKeychain(dir);
    } catch {
      // The account is connected; the meter will say why usage cannot be read.
    }
  }

  /** Whether the store now holds a login, whatever the client process did. */
  private async savedLogin(request: AccountLoginRequest): Promise<boolean> {
    return (await this.status(request)).connected;
  }

  /**
   * The vendor's own login with no browser here (`pasteCode`): its link,
   * the one whose page shows a code, goes to the bridge as a link to open
   * elsewhere, the code comes back as the answer to one prompt, and the
   * client takes it on its stdin and finishes the exchange itself. The
   * store, not the exit code, says whether it signed in. Stopping the
   * sign-in stops the client.
   *
   * A login it made is recorded in the account's folder (`MADE_LOGIN_FILE`),
   * so signing the account out, or removing the computer, signs that login
   * out too, and never one that was here before.
   */
  private async loginWithPastedCode(request: AccountLoginRequest, dir: string): Promise<void> {
    const { bridge } = request;
    let pasted: (code: string) => void = () => {};
    let stopped: (reason: unknown) => void = () => {};
    const paste = new Promise<string>((resolve, reject) => {
      pasted = resolve;
      stopped = reject;
    });
    // A paste the run never waited for (it ended first) is nobody's failure.
    paste.catch(() => {});
    const stop = () => stopped(new Error("Sign in cancelled"));
    bridge.signal?.addEventListener("abort", stop, { once: true });
    let output = "";
    let asked = false;
    try {
      const outcome = await runExclusiveStoreTask(dir, async () => {
        const decision = await this.replacementDecision(dir);
        if (decision === "adopt") return { kind: "adopt" as const };
        if (decision === "refuse") return { kind: "refuse" as const };
        const ran = await this.run(["auth", "login", "--claudeai"], dir, {
          timeoutMs: LOGIN_TIMEOUT_MS,
          env: { BROWSER: NO_BROWSER },
          paste,
          onStdout: (chunk) => {
            output += chunk;
            if (asked) return;
            const link = pasteCodeLink(output);
            if (!link) return;
            asked = true;
            bridge.notify({
              providerId: request.providerId,
              accountId: request.accountId,
              kind: "auth_url",
              message: "Open the link in your browser and sign in. Then paste the code it shows.",
              url: link,
            });
            bridge
              .prompt({
                promptId: randomUUID(),
                providerId: request.providerId,
                accountId: request.accountId,
                kind: "manual_code",
                message: "Paste the code Claude shows.",
                placeholder: "paste the code",
              })
              .then(pasted, stopped);
          },
        });
        return { kind: "ran" as const, ran };
      });
      if (outcome.kind === "adopt") {
        await this.finishAdopted(request, dir);
        return;
      }
      if (outcome.kind === "refuse") {
        throw new Error(CLAUDE_LOGIN_UNREADABLE_THERE_TEXT);
      }
      const status = await this.status(request);
      if (!status.connected) {
        throw new Error(
          loginFailure(outcome.ran.stderr, outcome.ran.stdout, CLAUDE_LOGIN_UNFINISHED_THERE_TEXT),
        );
      }
    } finally {
      bridge.signal?.removeEventListener("abort", stop);
      stop();
    }
    const { login } = await this.stamp(dir).catch((): CredentialStamp => ({}));
    const made: MadeLogin = { version: 1, ...(login ? { login } : {}), at: this.now() };
    try {
      writeFileSync(join(request.dir, MADE_LOGIN_FILE), `${JSON.stringify(made)}\n`, {
        mode: 0o600,
      });
    } catch {
      // The account is signed in; only its sign-out will keep the login here.
    }
    try {
      await this.primeKeychain(dir);
    } catch {
      // The account is connected; the meter will say why usage cannot be read.
    }
  }

  /**
   * Unbind, and sign out the login only when Firstmate made it here from a
   * pasted code (`signOutMadeLogin`). Any other login is the user's own
   * Claude Code login, which Infinitary does not own: running `claude auth
   * logout` over it would sign them out of Claude Code.
   */
  async logout(account: AccountRef): Promise<LogoutOutcome> {
    const login = await this.signOutMadeLogin(join(account.dir, MADE_LOGIN_FILE));
    clearKeychainLock(this.configDir());
    clearClaudeCredentialCache(this.configDir());
    return { login };
  }

  /**
   * Signs out the login Firstmate made here, as `file` records it, with the
   * vendor's own `claude auth logout`: `kept` with no record (a login it
   * adopted) or once another login took its place, and only while the login
   * here is still the one it made. Whose login it is comes from the stamp's
   * digest, which a renewal does not change; when either side cannot be
   * read it signs nothing out. The client's own word afterwards says whether
   * the login went. It runs where the work runs, in this user's login
   * session, since the client keeps the login in that session's Keychain
   * (docs/helper.md, "Removed").
   */
  async signOutMadeLogin(file: string): Promise<MachineLoginOutcome> {
    const made = readMadeLogin(file);
    if (!made) return "kept";
    const dir = this.configDir();
    return runExclusiveStoreTask(dir, async (): Promise<MachineLoginOutcome> => {
      // Gone already: signed out by hand, or by an earlier try.
      if ((await this.statusNow(dir))?.connected === false) return "signed-out";
      const { login } = await this.stamp(dir).catch((): CredentialStamp => ({}));
      if (login !== undefined && made.login !== undefined && login !== made.login) return "kept";
      if (login === undefined || made.login === undefined) return "not-signed-out";
      try {
        await this.run(["auth", "logout"], dir);
      } catch {
        return "not-signed-out";
      }
      return (await this.statusNow(dir))?.connected === false ? "signed-out" : "not-signed-out";
    });
  }

  /**
   * Ask the vendor's own client to rotate the session. Home of the
   * delegated ladder that used to live on the quota fetcher: Infinitary never
   * speaks Anthropic OAuth, and the outcome never carries a secret.
   */
  async renew(_account: AccountRef, _reason: RenewReason): Promise<RenewalOutcome> {
    void _account;
    void _reason;
    const result = await renewClaudeQuotaAuth(this.configDir(), {
      run: (configDir, args) => this.run([...args], configDir),
      keychain: this.keychain,
    });
    return result.outcome === "renewed" ? { outcome: "renewed" } : { outcome: result.outcome };
  }

  /**
   * Is the machine's default Claude login still signed in?
   *
   * The client's own answer is the fast path and the authority when it
   * arrives - but it is a spawned third-party binary, and every way it can
   * fail (missing, unspawnable, slow, output we cannot parse) produces the
   * same shape as a signed-out store. The vault turns "not connected" into a
   * red badge, a sign-in card, AND the removal of every one of this
   * provider's models from the routing pool, so guessing wrong is expensive
   * in one direction only.
   *
   * That is not hypothetical: in a packaged build the vendored client
   * resolved to a path inside app.asar, where `spawn` cannot reach it, and a
   * fully signed-in Max account rendered "sign in again" next to its own
   * live quota bars with no Claude model left to route to (captain dogfood,
   * 2026-09-01). So when the probe cannot answer, the default store does -
   * and only a store with no credential, or one whose refresh token has
   * lapsed, is reported as needing a sign-in.
   *
   * `status()` is a projection of `health()` (spec §11.2.5). Unknown and
   * no-interaction failures stay degraded, never a sign-out.
   */
  async health(_account: AccountRef): Promise<CredentialHealth> {
    void _account;
    const client = await this.client();
    const credential = await this.credentialHealth(client.state === "ready");
    // The stamp a cut-off is recorded under: the login and its client, from
    // attributes only (docs/quota.md "Typed cut-offs").
    const stored = await this.stamp(this.configDir()).catch((): CredentialStamp => ({}));
    const version = client.state === "missing" ? undefined : client.version;
    const stamp = { ...stored, ...(version ? { client: version } : {}) };
    const health = Object.keys(stamp).length > 0 ? { ...credential, stamp } : credential;
    // The client is a fact beside the credential (F14): a live login with
    // no client to run it is degraded with the sentence, never a sign-out,
    // and a sign-out stays a sign-out whatever the client's state.
    const issue = claudeClientIssueReason(client);
    if (issue === undefined || health.state === "unsigned" || health.state === "needs_reauth") {
      return health;
    }
    const detail = claudeClientIssueText(client);
    return { ...health, state: "degraded", reason: issue, ...(detail ? { detail } : {}) };
  }

  /** Which login the default store names: the stamp's, from attributes only. */
  async loginStamp(_account: AccountRef): Promise<string | undefined> {
    void _account;
    return (await this.stamp(this.configDir()).catch((): CredentialStamp => ({}))).login;
  }

  /** The credential's own health, from the client's probe (when one can run) and the store. */
  private async credentialHealth(probeAllowed: boolean): Promise<CredentialHealth> {
    const dir = this.configDir();
    const probe = probeAllowed ? await this.probe(dir) : undefined;
    const evidence = await this.evidence(dir);
    // Live: date the token from the file store only, so a status poll never
    // spends a Keychain VALUE read (that grant is the meter's). Unknown: a
    // persistLock=false peek classifies a blocked session without locking Retry.
    const peek =
      evidence.state === "live" || evidence.state === "unknown"
        ? await this.peek(dir, evidence.state === "live")
        : undefined;

    // A signed-in client is the authority, including over a stale file the
    // evidence read already reconciled or a file-only peek still sees.
    if (probe?.connected) {
      const identity =
        probe.identity ??
        identityOf(evidence.state === "live" ? evidence.label : undefined).identity;
      const expiresAt = peek?.kind === "resolved" ? peek.expiresAt : undefined;
      const state = classifyExpiry(expiresAt, this.now(), this.leadMs);
      return {
        state,
        authType: "oauth",
        ...(identity ? { identity } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };
    }

    if (evidence.state === "live") {
      const identity = identityOf(evidence.label).identity;
      const expiresAt = peek?.kind === "resolved" ? peek.expiresAt : undefined;
      const state = classifyExpiry(expiresAt, this.now(), this.leadMs);
      return {
        state,
        authType: "oauth",
        ...(identity ? { identity } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };
    }

    if (evidence.state === "unknown") {
      if (probe && !probe.connected) return { state: "unsigned" };
      return {
        state: "degraded",
        reason: peek?.kind === "blocked" ? peek.reason : "unknown",
      };
    }

    return { state: "unsigned" };
  }

  async status(account: AccountRef): Promise<AccountStatus> {
    return statusFromHealth(await this.health(account));
  }

  /**
   * A no-prompt look at expiry for proactive renewal. Locked / unavailable
   * must not override a live evidence read: the credential is there, we
   * just cannot date it this tick (rule 3). `fileOnly` skips the Keychain
   * VALUE so a live status poll cannot spend the meter's grant.
   */
  private async peek(
    dir: string,
    fileOnly: boolean,
  ): Promise<
    { kind: "resolved"; expiresAt?: number } | { kind: "blocked"; reason: string } | undefined
  > {
    try {
      const result: ClaudeQuotaAuthResult = await resolveClaudeQuotaAuthResult(dir, {
        keychain: this.keychain,
        allowPrompt: false,
        persistLock: false,
        // A file-only peek stays file-only: it never reads the Keychain, so
        // the credential the meter remembered from it is left alone instead
        // of being forgotten by a store that "looks absent".
        ...(fileOnly ? { fileOnly: true } : {}),
        now: this.now,
      });
      if (result.status === "resolved") {
        return { kind: "resolved", expiresAt: result.auth.expiresAt };
      }
      if (result.status === "locked") return { kind: "blocked", reason: result.reason };
      if (result.status === "unavailable" && result.reason) {
        return { kind: "blocked", reason: result.reason };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The client's own status read, or nothing if it could not produce one.
   *
   * It goes through the store lease like every other client run, and it
   * DEFERS rather than waits: this is a background poll, and the default
   * store already answers by attribute (`readClaudeCredentialEvidence`) when
   * the probe cannot. Deferring keeps a status poll from queueing behind a
   * renewal, and keeps it from becoming a second refresher of its own.
   */
  private async probe(dir: string): Promise<AccountStatus | undefined> {
    const claimed = await tryExclusiveStoreTask(dir, async () => {
      try {
        const result = await this.run(["auth", "status", "--json"], dir);
        return parseJsonStatus(result.stdout);
      } catch {
        return undefined;
      }
    });
    return claimed.ran ? claimed.value : undefined;
  }

  /** The client's own status read, inside a store task already held; nothing when it cannot answer. */
  private async statusNow(dir: string): Promise<AccountStatus | undefined> {
    try {
      return parseJsonStatus((await this.run(["auth", "status", "--json"], dir)).stdout);
    } catch {
      return undefined;
    }
  }

  binding(_account: AccountRef): AccountBinding {
    return { via: "default-login" };
  }
}

/** Claude's own status read, narrowed defensively (`unknown` in, narrow out). */
export function parseStatus(stdout: string): AccountStatus {
  return parseJsonStatus(stdout) ?? { connected: false };
}

/**
 * The same read, keeping the one distinction `status` turns on: `undefined`
 * means the client did not give us an answer at all, which is not the same
 * claim as "this store is signed out".
 */
function parseJsonStatus(stdout: string): AccountStatus | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.loggedIn !== "boolean") return undefined;
  if (!record.loggedIn) return { connected: false };
  const email = typeof record.email === "string" ? record.email : undefined;
  const plan =
    typeof record.subscriptionType === "string" ? planLabel(record.subscriptionType) : undefined;
  const identity =
    email || plan ? { ...(email ? { label: email } : {}), ...(plan ? { plan } : {}) } : undefined;
  return {
    connected: true,
    authType: record.authMethod === "apiKey" ? "api_key" : "oauth",
    ...(identity ? { identity } : {}),
  };
}

/** The account line's identity, when the store knew one. */
function identityOf(label: string | undefined): { identity?: { label: string } } {
  return label ? { identity: { label } } : {};
}

/** Plan names as the user knows them, not as the API spells them. */
function planLabel(subscriptionType: string): string {
  const known: Record<string, string> = {
    max: "Max",
    pro: "Pro",
    team: "Team",
    enterprise: "Enterprise",
  };
  return known[subscriptionType] ?? subscriptionType;
}

/**
 * Claude's own words when a sign-in fails; a generic message helps nobody.
 * Its error stream says why when it says anything, before what it printed
 * while it waited. A line ending in a colon only introduces a reason, so an
 * error stream of those alone ("Login failed: ") gives none: the sign-in
 * then ends with `unfinished`, never the bare label or a waiting line.
 */
function loginFailure(stderr: string, stdout: string, unfinished: string): string {
  const lines = (stream: string) =>
    stream
      .split("\n")
      .map((line) => line.trim())
      // What it printed while it waited is not why it stopped: the authorize
      // URL is machinery, and by failure time it is spent, as are its prompts.
      .filter(
        (line) =>
          line &&
          !line.includes("https://") &&
          !line.startsWith("Opening browser") &&
          !line.includes("Paste code here"),
      );
  const why = lines(stderr);
  const said = (why.length > 0 ? why : lines(stdout)).filter((line) => !line.endsWith(":"));
  return said.slice(-3).join(" ") || unfinished;
}
