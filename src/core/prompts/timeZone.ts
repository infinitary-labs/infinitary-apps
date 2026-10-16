/**
 * The captain's time zone, as the Firstmate's context block and a crewmate's
 * prompt name it (FI3-1006, the captain's words: "whenever firstmate or
 * crewmate mentions time, by default it should use the user's local time.
 * UTC is very difficult to understand").
 *
 * The rule itself is one sentence of `CARD_AUTHORING`, which every persona
 * reads once; this is only the fact it needs. The zone is this Mac's own
 * zone, read where the host builds the words, and its offset is the one in
 * force at `at`, so a model can turn a time a source gives in UTC into the
 * captain's local time without knowing the zone's daylight-saving rules.
 */

/** This Mac's time zone name, such as `America/Los_Angeles`; `UTC` when the runtime names none. */
export function localTimeZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * A zone and its offset from UTC at `at`, such as
 * `America/Los_Angeles (UTC-07:00)` or `Asia/Kolkata (UTC+05:30)`.
 * A zone the runtime cannot read keeps its name alone.
 */
export function timeZoneFact(at: number, zone: string = localTimeZoneName()): string {
  const offset = utcOffset(at, zone);
  return offset ? `${zone} (${offset})` : zone;
}

/** The zone's offset at `at`, written `UTC+05:30`; undefined when the runtime cannot say. */
function utcOffset(at: number, zone: string): string | undefined {
  let name: string | undefined;
  try {
    name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(new Date(at))
      .find((part) => part.type === "timeZoneName")?.value;
  } catch {
    return undefined;
  }
  // `GMT` alone is the zero offset; otherwise `GMT-07:00`.
  if (name === "GMT") return "UTC+00:00";
  const match = name ? /^GMT([+-]\d{2}:\d{2})$/.exec(name) : null;
  return match ? `UTC${match[1]}` : undefined;
}
