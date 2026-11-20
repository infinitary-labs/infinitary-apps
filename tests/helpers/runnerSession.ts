/**
 * The variables a test run inherits from the session that started it, and
 * that a run in CI never has. A Claude crewmate's shell hands every command
 * it runs `CLAUDECODE`, `AI_AGENT` and its own `CLAUDE_*` (its messaging
 * socket and token, its session id, effort, pid and entrypoint); a person's
 * shell may carry `ANTHROPIC_*` for their own client. Through `hostEnv()`
 * they would reach the e2e app and every boxed Claude client, ahead of the
 * SDK's own entrypoint and version (FI3-741). A test that wants one names it
 * in the environment it builds.
 */
function fromRunnerSession(name: string): boolean {
  return name === "AI_AGENT" || name.startsWith("CLAUDE") || name.startsWith("ANTHROPIC_");
}

/** `env` without the runner's session variables. */
export function withoutRunnerSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !fromRunnerSession(name)));
}

/**
 * Drop the runner's session variables from this process. Each runner's
 * global setup calls it before any worker starts, so every worker, app and
 * client the run starts begins without them.
 */
export function leaveRunnerSession(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of Object.keys(env)) {
    if (fromRunnerSession(name)) delete env[name];
  }
}
