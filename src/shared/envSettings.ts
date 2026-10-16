/**
 * A setting an environment variable names. Infinitary's name for a setting is
 * `INFINITARY_<NAME>`; the Firstmate 3000 name `FM3000_<NAME>` keeps reading,
 * so a development run, a test or a script written for either still works.
 * When both are set the Infinitary name wins, even when it is empty: it is the
 * newer word, and a deliberately empty value keeps its meaning.
 */
export const SETTING_PREFIXES = ["INFINITARY_", "FM3000_"] as const;

export function settingFrom(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  for (const prefix of SETTING_PREFIXES) {
    const value = env[`${prefix}${name}`];
    if (value !== undefined) return value;
  }
  return undefined;
}
