import { git } from "../../workspace/git";
import { type Forge, type ForgeChange, ForgeError, type ForgeLocation } from "../forge";

/**
 * A plain Git host (`git`) (the captain's Q4 and Q5, 2026-09-24): a proposed change is the
 * working copy SENT UP as its own branch. It has no number, no page and no
 * checks - the local gate is the evidence - so it reads green with zero
 * checks, and putting it in fast-forwards the default branch onto the
 * checked head and sends that up. The push is never forced: a default
 * branch that moved on since is refused by the host, and the work has to be
 * brought up to date first.
 *
 * Every call is git against the repository's own `origin`, with prompts
 * off so a host asking for a sign-in fails fast instead of hanging.
 */

const GIT_TIMEOUT_MS = 30_000;

export class PlainGitForge implements Forge {
  readonly kind;
  readonly host;
  readonly place;
  readonly hasChecks = false;

  constructor(
    readonly location: ForgeLocation & { place: string | null },
    private readonly approvedOrigin?: string | null,
  ) {
    this.kind = location.kind;
    this.host = location.host;
    this.place = location.place;
  }

  async listProjects() {
    return [];
  }

  async storyDestination() {
    return {
      kind: "branch" as const,
      origin: await this.run(["config", "--get", "remote.origin.url"]),
    };
  }

  async branchHead(branch: string): Promise<string> {
    const change = await this.changeFor(branch);
    if (!change) throw new ForgeError("not-found", "The pushed branch was not found.");
    return change.headSha;
  }

  async defaultBranch(): Promise<string> {
    const symref = await this.run(["ls-remote", "--symref", "origin", "HEAD"]);
    const named = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(symref)?.[1];
    if (named) return named;
    throw new ForgeError("not-found", "the project's host does not name a default branch");
  }

  async openChange(input: { branch: string; source?: string }): Promise<ForgeChange> {
    const source = input.source ?? `refs/heads/${input.branch}`;
    await this.assertWriteRoute();
    await this.run(["push", "origin", `${source}:refs/heads/${input.branch}`]);
    const sent = await this.changeFor(input.branch);
    if (!sent)
      throw new ForgeError("not-found", `${input.branch} was not found after sending it up`);
    return sent;
  }

  async changeFor(branch: string): Promise<ForgeChange | null> {
    const listed = await this.run(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
    const headSha = listed
      .split("\n")
      .map((line) => line.split("\t"))
      .find(([, ref]) => ref === `refs/heads/${branch}`)?.[0];
    return headSha ? { branch, headSha, url: null } : null;
  }

  async checks() {
    return { items: [] };
  }

  async putIn(change: ForgeChange, headSha: string): Promise<undefined> {
    const current = await this.changeFor(change.branch);
    if (!current) {
      throw new ForgeError("not-found", `${change.branch} is no longer where the project lives`);
    }
    if (current.headSha !== headSha) {
      throw new ForgeError(
        "refused",
        `${change.branch} moved to ${current.headSha} after the checks read ${headSha}`,
      );
    }
    const target = await this.defaultBranch();
    await this.assertWriteRoute();
    await this.run(["push", "origin", `${headSha}:refs/heads/${target}`]);
    return undefined;
  }

  async close(change: ForgeChange): Promise<void> {
    try {
      await this.assertWriteRoute();
      await this.run(["push", "origin", "--delete", `refs/heads/${change.branch}`]);
    } catch (caught) {
      // Already gone where the project lives: there is nothing to take back.
      if (caught instanceof ForgeError && /remote ref does not exist/i.test(caught.message)) return;
      throw caught;
    }
  }

  label(change: ForgeChange): string {
    return change.branch;
  }

  url(): string | null {
    return null;
  }

  /** Both Git routes must name the approved destination; pushurl can override an ordinary read URL. */
  private async assertWriteRoute(): Promise<void> {
    if (!this.approvedOrigin) return;
    const checked = await Promise.all([
      this.run(["config", "--get-all", "remote.origin.url"]),
      this.run(["remote", "get-url", "--all", "origin"]),
      this.run(["remote", "get-url", "--push", "--all", "origin"]),
    ]).catch(() => undefined);
    if (
      !checked ||
      checked[0] !== this.approvedOrigin ||
      checked[1].includes("\n") ||
      checked[1] !== checked[2]
    )
      throw new ForgeError(
        "refused",
        "The checkout's read and push addresses must match the approved project address.",
      );
  }

  private async run(args: string[]): Promise<string> {
    try {
      return await git(this.location.dir, args, {
        env: { GIT_TERMINAL_PROMPT: "0" },
        timeoutMs: GIT_TIMEOUT_MS,
      });
    } catch (caught) {
      throw gitFailure(caught);
    }
  }
}

/** Known git shapes, keyed on git's own words, never loose ones. */
const SIGN_IN =
  /could not read Username|Authentication failed for|Permission denied \(publickey\)/i;
const TRANSIENT =
  /Could not resolve host|Failed to connect|Connection timed out|Connection refused|Operation timed out|The remote end hung up unexpectedly/i;

function gitFailure(caught: unknown): ForgeError {
  const stderr = (caught as { stderr?: unknown }).stderr;
  const killed = (caught as { killed?: unknown }).killed === true;
  const message =
    (typeof stderr === "string" && stderr.trim()) ||
    (caught instanceof Error ? caught.message : String(caught));
  if (killed) return new ForgeError("transient", `the project's host did not answer: ${message}`);
  if (SIGN_IN.test(message)) return new ForgeError("sign-in", message);
  if (TRANSIENT.test(message)) return new ForgeError("transient", message);
  // Everything else is the host's verdict on the push itself: a default
  // branch that moved on, a protected branch, a declined hook.
  return new ForgeError("refused", message);
}
