/**
 * Linux's own way to hear what computers on this network announce, as
 * computers nearby read it (docs/devices.md, "Macs nearby"): Avahi's
 * `avahi-browse`, which only listens and asks the Avahi daemon; it sends
 * nothing to any address. A Mac's Remote Login announces `_ssh._tcp`, and so
 * does a Linux computer whose SSH server Avahi announces.
 *
 * `avahi-browse --parsable --resolve` prints one line for each computer it
 * hears on each interface and protocol (`+`), each it hears go (`-`), and
 * each it resolved to its name on this network (`=`), with `;` between the
 * fields and the computer's own name escaped as Avahi escapes a label.
 */

/** What `avahi-browse` is asked: Remote Login's service, each answer resolved, nothing read from its own names list. */
export const AVAHI_BROWSE_ARGS = [
  "--parsable",
  "--resolve",
  "--no-db-lookup",
  "_ssh._tcp",
] as const;

/** One line of `avahi-browse --parsable --resolve`. */
export type AvahiLine =
  | { kind: "add" | "remove"; name: string; where: string }
  | { kind: "reached"; name: string; where: string; at: string };

/**
 * A computer's own name as Avahi prints it: `\.` and `\\` for a dot and a
 * backslash, and `\DDD`, a byte in decimal, for a space or any byte it does
 * not print as itself. Null when the escapes do not read.
 */
export function readAvahiName(text: string): string | null {
  const bytes: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? "";
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const digits = /^\d{3}/.exec(text.slice(at + 1))?.[0];
    if (digits) {
      const byte = Number(digits);
      if (byte > 255) return null;
      bytes.push(byte);
      at += 3;
      continue;
    }
    const next = text[at + 1];
    if (next === undefined) return null;
    bytes.push(...Buffer.from(next, "utf8"));
    at += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** What one line says, or null for anything else: a note, an error, a line cut short. */
export function readAvahiLine(line: string): AvahiLine | null {
  const fields = line.trim().split(";");
  const [event, iface, protocol, name, type] = fields;
  if (!event || !iface || !protocol || name === undefined || type !== "_ssh._tcp") return null;
  const read = readAvahiName(name);
  if (!read) return null;
  const where = `${iface};${protocol}`;
  if (event === "+") return { kind: "add", name: read, where };
  if (event === "-") return { kind: "remove", name: read, where };
  if (event !== "=") return null;
  const host = fields[6]?.replace(/\.$/, "");
  return host ? { kind: "reached", name: read, where, at: host } : null;
}
