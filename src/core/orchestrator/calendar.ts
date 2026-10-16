/**
 * Wall-clock time in a named time zone (docs/automation.md, "Calendars"):
 * the instants a daily or chosen-days rule runs at, from the IANA zone it
 * keeps. Pure, on the platform's own time zone data (`Intl`).
 *
 * Daylight saving: a local time that happens twice runs once, at its
 * earlier instant; a local time that does not exist runs at the first
 * valid minute after it.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const formats = new Map<string, Intl.DateTimeFormat>();

function formatIn(timeZone: string): Intl.DateTimeFormat {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formats.set(timeZone, format);
  }
  return format;
}

/** Whether the platform knows `timeZone` as an IANA zone. */
export function isTimeZone(timeZone: string): boolean {
  try {
    formatIn(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The zone this computer's clock follows now. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number };

/** The wall clock in `timeZone` at `ms`, to the minute. */
function wallAt(ms: number, timeZone: string): Wall {
  const parts: Record<string, number> = {};
  for (const part of formatIn(timeZone).formatToParts(ms)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
  };
}

/** A wall clock read as if it were UTC: comparable and steppable by plain arithmetic. */
function asUtc(wall: Wall): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

/** How far the zone's wall clock runs ahead of UTC at `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  return asUtc(wallAt(ms, timeZone)) - Math.floor(ms / MINUTE) * MINUTE;
}

/**
 * The earliest instant whose wall clock in `timeZone` reads `target` (a wall
 * time as `asUtc` writes it), or null when the zone skips that minute.
 */
function exactInstant(target: number, timeZone: string): number | null {
  const candidates = new Set(
    [target - DAY, target, target + DAY].map((near) => target - offsetAt(near, timeZone)),
  );
  const matching = [...candidates]
    .filter((instant) => asUtc(wallAt(instant, timeZone)) === target)
    .sort((a, b) => a - b);
  return matching[0] ?? null;
}

/**
 * The instant a local date and time in `timeZone` means: its earlier
 * instant when the clock passes it twice, the first valid minute after it
 * when the clock skips it.
 */
export function zonedInstant(
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const target = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // A skipped stretch is at most a day long (a zone that moved across the date line).
  for (let step = 0; step <= 24 * 60; step++) {
    const instant = exactInstant(target + step * MINUTE, timeZone);
    if (instant !== null) return instant;
  }
  throw new Error(`No valid time follows ${hour}:${minute} in ${timeZone}.`);
}

/**
 * The first time strictly after `from` that the wall clock in `timeZone`
 * reads `hour:minute` on one of `days` (0 is Sunday; every day when absent).
 */
export function nextZonedFire(
  from: number,
  hour: number,
  minute: number,
  timeZone: string,
  days?: readonly number[],
): number {
  const today = wallAt(from, timeZone);
  for (let ahead = 0; ahead <= 8; ahead++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + ahead));
    if (days && !days.includes(date.getUTCDay())) continue;
    const instant = zonedInstant(
      { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
      hour,
      minute,
      timeZone,
    );
    if (instant > from) return instant;
  }
  throw new Error("A weekly schedule needs at least one day.");
}
