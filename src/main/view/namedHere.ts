import { HomeRefusalError } from "@core/devices/homeLink";
import { hereAs } from "@shared/deviceNames";
import type { FeedLine } from "@shared/feed";
import type { CoreInvokeChannel } from "@shared/ipc";

/**
 * The first mate's own words, as a computer that controls it shows them
 * (docs/view.md, "The first mate's own words"). The first mate's core
 * writes its computer as this computer (`HERE`), which there names the
 * computer the captain is at. Here each such sentence names the first
 * mate's computer by `name` instead (`hereAs`), read only when one does:
 *
 * - each feed line it marks as its own words (`saidHere`), never one of the
 *   captain's or a crewmate's words;
 * - a refusal it answers, in the shapes the contract's refusals take: the
 *   answer's `refusal`, its `text` beside `ok: false`, and the `warning`
 *   beside `ok: true`;
 * - a request it refused with an error (`HomeRefusalError`).
 *
 * The first mate's own window never comes here, so it shows each sentence
 * as written.
 */
export function namedHere(
  channel: CoreInvokeChannel,
  answer: unknown,
  name: () => string,
): unknown {
  if (channel === "inf:feed:recent" && Array.isArray(answer))
    return answer.map((line: FeedLine) =>
      line?.saidHere === true ? { ...line, text: hereAs(line.text, name()) } : line,
    );
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return answer;
  const fields = answer as Record<string, unknown>;
  const field =
    typeof fields.refusal === "string"
      ? "refusal"
      : fields.ok === false && typeof fields.text === "string"
        ? "text"
        : fields.ok === true && typeof fields.warning === "string"
          ? "warning"
          : null;
  return field ? { ...fields, [field]: hereAs(fields[field] as string, name()) } : answer;
}

/** A request's error, with the home's own refusal named as above and every other error as it was. */
export function namedHereError(caught: unknown, name: () => string): unknown {
  return caught instanceof HomeRefusalError ? new Error(hereAs(caught.message, name())) : caught;
}
