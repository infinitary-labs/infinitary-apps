// INF-662 piece 1: the phone check builds once and gives each device's tests their own
// test home. Xcode writes the scheme's PHONE_TEST_HOME, empty, into each test target's
// environment in the built test plan (.xctestrun, format 1: one key per target).

/** The plutil key paths of every test target's PHONE_TEST_HOME in a built test plan, read as JSON. */
export function testHomeKeys(plan: Record<string, unknown>): string[] {
  const keys = Object.entries(plan).filter(([, target]) => {
    const environment = (target as { EnvironmentVariables?: Record<string, unknown> } | null)?.EnvironmentVariables;
    return typeof environment === "object" && environment !== null && "PHONE_TEST_HOME" in environment;
  }).map(([name]) => `${name}.EnvironmentVariables.PHONE_TEST_HOME`);
  if (keys.length === 0) throw new Error("The built test plan has no PHONE_TEST_HOME to name a test home in");
  return keys;
}
