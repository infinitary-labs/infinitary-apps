import { existsSync, readdirSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where Claude's own client keeps a session transcript.
 *
 * A Claude crewmate's `tasks.session_file` is the session id Infinitary minted
 * for the resume token (session.ts), not a file. The client writes
 * the transcript itself, as JSONL, under the machine's default config root:
 * `~/.claude/projects/<encoded cwd>/<session id>.jsonl` (CD-1=B leaves
 * CLAUDE_CONFIG_DIR unset so the client uses that store). Measured against the vendored client
 * (2026-09-05): the file appears with the first user line, before the
 * first API call.
 *
 * The cwd encoding is the client's, not a contract: every character
 * outside [A-Za-z0-9-] becomes "-". It is tried first because it is one
 * stat; the fallback walks `projects/` for the id, so a future encoding
 * change degrades to a directory scan rather than to a blank pane.
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

export function locateClaudeTranscript(input: {
  configDir: string;
  cwd: string;
  sessionId: string;
}): string | null {
  const file = `${input.sessionId}.jsonl`;
  const projects = join(input.configDir, "projects");
  const direct = join(projects, encodeClaudeProjectDir(input.cwd), file);
  if (existsSync(direct)) return direct;
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(projects, dir, file);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** A rolling session's lookup: fast known paths, with no project walk on the main thread. */
export class ClaudeTranscriptLookup {
  private readonly located = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string | null>>();

  constructor(
    private readonly configDir: string,
    private readonly cwd: string,
  ) {}

  /** The client can write after an earlier miss; misses are never cached. */
  read(sessionId: string): string | null {
    const path =
      this.located.get(sessionId) ??
      join(this.configDir, "projects", encodeClaudeProjectDir(this.cwd), `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
    this.located.delete(sessionId);
    return null;
  }

  /** Overlapping refreshes share discovery, but a later miss is checked again. */
  find(sessionId: string): Promise<string | null> {
    const known = this.read(sessionId);
    if (known) return Promise.resolve(known);
    const pending = this.pending.get(sessionId);
    if (pending) return pending;
    const search = locateClaudeTranscriptAsync({
      configDir: this.configDir,
      cwd: this.cwd,
      sessionId,
    })
      .then((path) => {
        if (path) this.located.set(sessionId, path);
        return path;
      })
      .finally(() => this.pending.delete(sessionId));
    this.pending.set(sessionId, search);
    return search;
  }
}

/** Same fallback as the synchronous reader, yielding to the app between filesystem reads. */
export async function locateClaudeTranscriptAsync(input: {
  configDir: string;
  cwd: string;
  sessionId: string;
}): Promise<string | null> {
  const file = `${input.sessionId}.jsonl`;
  const projects = join(input.configDir, "projects");
  const direct = join(projects, encodeClaudeProjectDir(input.cwd), file);
  if (await exists(direct)) return direct;
  let dirs: string[];
  try {
    dirs = await readdir(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(projects, dir, file);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
