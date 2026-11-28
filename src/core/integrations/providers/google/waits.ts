import { nextZonedFire } from "../../../orchestrator/calendar";
import type { GoogleService } from "./mcp";

/**
 * How long each Google service waits after Google asks the app to slow down
 * (docs/integrations.md, "Google"). Each Google service has its own
 * daily allowance at Google, so a refusal from one holds only
 * that one.
 *
 * - A Retry-After is waited out as Google says.
 * - A 429 whose body names a daily limit, with no Retry-After, waits until
 *   the next midnight Pacific time, when Google resets daily limits: asking
 *   sooner only spends refused requests, which Google counts too.
 * - Any other 429 waits one minute, doubling on each refusal in a row up to
 *   an hour, as Google's error guide asks of a per-minute limit; the next
 *   answer from that service starts the doubling over.
 */

const BACKOFF_FIRST_MS = 60_000;
const BACKOFF_MOST_MS = 3_600_000;

/** Google resets its daily limits at midnight in this zone. */
const GOOGLE_RESET_ZONE = "America/Los_Angeles";

/** The next midnight in Pacific time after `now`, in milliseconds since 1970. */
export function nextPacificMidnight(now: number): number {
  return nextZonedFire(now, 0, 0, GOOGLE_RESET_ZONE);
}

/** Retry-After in milliseconds: seconds, or a date. */
function retryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Whether a refusal's body names a daily limit: Gmail's own `dailyLimitExceeded`
 * reason, or a Google Cloud quota error whose words or `quota_limit` name a day.
 */
export function namesDailyLimit(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return false;
  const { message, errors, details } = error as {
    message?: unknown;
    errors?: unknown;
    details?: unknown;
  };
  const reasons = Array.isArray(errors)
    ? errors.map((entry) => (entry as { reason?: unknown } | null)?.reason)
    : [];
  if (reasons.includes("dailyLimitExceeded")) return true;
  const limits = Array.isArray(details)
    ? details.map(
        (entry) =>
          (entry as { metadata?: { quota_limit?: unknown } } | null)?.metadata?.quota_limit,
      )
    : [];
  return [message, ...limits].some(
    (words) => typeof words === "string" && /per ?day|daily/i.test(words),
  );
}

type Wait = { until: number; daily: boolean; refusedInARow: number };

export type GoogleWaits = {
  /** Words for a request that must not leave yet, or undefined when it may. */
  holds: (service: GoogleService, label: string) => string | undefined;
  /** Google answered 429: keep the wait and answer its words for the crew. */
  slowed: (
    service: GoogleService,
    label: string,
    retryAfterHeader: string | null,
    body: unknown,
  ) => string;
  /** Google answered the service: its doubling starts over. */
  answered: (service: GoogleService) => void;
  clear: () => void;
};

export function googleWaits(now: () => number): GoogleWaits {
  const waits = new Map<GoogleService, Wait>();
  return {
    holds: (service, label) => {
      const wait = waits.get(service);
      if (!wait) return undefined;
      const left = wait.until - now();
      if (left <= 0) return undefined;
      // i18n-exempt: words served to the crew, which stay English
      if (wait.daily)
        return `${label} reached its daily request limit at Google, so the app waits until midnight Pacific time to ask again.`;
      // i18n-exempt: words served to the crew, which stay English
      return `${label} asked the app to wait ${Math.ceil(left / 1000)} more seconds.`;
    },
    slowed: (service, label, header, body) => {
      const at = now();
      const told = retryAfter(header, at);
      const refusedInARow = (waits.get(service)?.refusedInARow ?? 0) + 1;
      if (told !== undefined) {
        waits.set(service, { until: at + told, daily: false, refusedInARow });
        // i18n-exempt: words served to the crew, which stay English
        return `${label} asked the app to slow down for ${Math.ceil(told / 1000)} seconds.`;
      }
      if (namesDailyLimit(body)) {
        waits.set(service, { until: nextPacificMidnight(at), daily: true, refusedInARow });
        // i18n-exempt: words served to the crew, which stay English
        return `${label} reached its daily request limit at Google, so the app waits until midnight Pacific time, when Google resets it.`;
      }
      const wait = Math.min(BACKOFF_FIRST_MS * 2 ** (refusedInARow - 1), BACKOFF_MOST_MS);
      waits.set(service, { until: at + wait, daily: false, refusedInARow });
      // i18n-exempt: words served to the crew, which stay English
      return `${label} asked the app to slow down without saying for how long, so the app waits ${Math.ceil(wait / 1000)} seconds.`;
    },
    answered: (service) => {
      waits.delete(service);
    },
    clear: () => waits.clear(),
  };
}
