import { existsSync, readdirSync } from "node:fs";
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
