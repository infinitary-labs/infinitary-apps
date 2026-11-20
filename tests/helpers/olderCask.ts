/**
 * A cask as the generator wrote it before it supported Homebrew older than
 * 6.0.15 - what the public tap carried until its casks were republished
 * (docs/alpha.md "Republishing the casks"): the declared marker step alone,
 * with no legacy postflight beside it. Homebrew 5.1.13 refuses it for
 * `postflight_steps`, and 5.1.14 to 6.0.14 for `write_file`. Everything
 * else - the artifact, the stanzas, the notice - is the given cask's.
 */
export function declaredStepOnly(cask: string): string {
  const older = cask.replace(
    /^ {2}if defined\?\(Homebrew::InstallSteps::DSL\)[^\n]*\n((?: {4}[^\n]*\n)+?) {2}else\n(?: {4}[^\n]*\n)+? {2}end\n/m,
    (_block, declared: string) => declared.replace(/^ {2}/gm, ""),
  );
  if (older === cask) throw new Error("the cask has no capability-gated marker step");
  return older;
}
