/**
 * A check's refusal as GitHub reads it (docs/testing.md, "A failed check
 * says why"). A step that only prints its reason and exits 1 leaves GitHub's
 * summary at "Process completed with exit code 1."; a line in GitHub's
 * error format becomes an annotation the summary shows, beside the file it
 * names. Inside GitHub Actions each refusal prints in that format, and
 * anywhere else as the plain line it always was. Plain Node type stripping,
 * no install: the checks that call it run before anything is set up.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** GitHub's escapes for a command's message and for a property's value. */
const escapeMessage = (text: string) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (text: string) =>
  escapeMessage(text).replaceAll(":", "%3A").replaceAll(",", "%2C");

/**
 * The repository path a problem leads with, as `path: what is wrong`, when
 * it looks like one: a path with a folder or an extension, and no space.
 */
export function leadingPath(problem: string): string | undefined {
  const match = /^([^\s:]+): /.exec(problem);
  const path = match?.[1];
  return path && (path.includes("/") || /\.[A-Za-z0-9]+$/.test(path)) ? path : undefined;
}

/**
 * One refusal as the line to print: GitHub's error format inside GitHub
 * Actions, naming `file` when given or the path the problem leads with, and
 * the problem itself everywhere else.
 */
export function errorLine(
  problem: string,
  options: { file?: string; title?: string } = {},
  env: Env = process.env,
): string {
  if (env.GITHUB_ACTIONS !== "true") return problem;
  const file = options.file ?? leadingPath(problem);
  const properties = [
    ...(file ? [`file=${escapeProperty(file)}`] : []),
    ...(options.title ? [`title=${escapeProperty(options.title)}`] : []),
  ];
  return `::error${properties.length ? ` ${properties.join(",")}` : ""}::${escapeMessage(problem)}`;
}

export function printErrors(
  problems: readonly string[],
  options: { title?: string } = {},
  env: Env = process.env,
): void {
  for (const problem of problems) console.error(errorLine(problem, options, env));
}

/**
 * A generated file that differs from what its generator writes now: prints
 * the refusal and returns the error the generator throws, so the step fails
 * as before and GitHub's summary names the file and the command that
 * refreshes it.
 */
export function staleGeneratedFile(file: string, command: string, env: Env = process.env): Error {
  const problem = `${file}: out of step with its generator; run ${command} and commit the result`;
  console.error(errorLine(problem, { title: "Generated file out of step" }, env));
  return new Error(problem);
}
