import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writePrivate } from "../devices/identity";

/**
 * The sign-ins a moved first mate asks for again (docs/devices.md, "What
 * stays"): the move copies none, so the new home asks the captain for each
 * one the old home had, once, with one card each, and takes a card down
 * once that sign-in is here.
 */
export const SIGN_IN_AGAIN_FILE = "sign-in-again.json";

/** The card asking for one sign-in again, by what it names. */
export const SIGN_IN_AGAIN_CARD = "card-sign-in-again-";

const signInSchema = z.object({
  /** A provider's id, or the host where projects live. */
  id: z.string().min(1).max(253),
  kind: z.enum(["provider", "forge"]),
  name: z.string().min(1).max(64),
  /** Its card went up once; a card the captain put away is not raised again. */
  asked: z.boolean(),
});
const fileSchema = z.object({
  version: z.literal(1),
  from: z.string().min(1).max(160),
  signIns: z.array(signInSchema).max(128),
});
type SignInsFile = z.infer<typeof fileSchema>;
export type SignInToAsk = z.infer<typeof signInSchema>;

/** Kept by the destination as it puts the record in place: what the old home was signed in to. */
export function keepSignInsToAsk(
  userData: string,
  from: string,
  signIns: {
    providers: readonly { id: string; name: string }[];
    forges: readonly { host: string; name: string }[];
  },
): void {
  const file: SignInsFile = {
    version: 1,
    from,
    signIns: [
      ...signIns.providers.map(({ id, name }) => ({
        id,
        kind: "provider" as const,
        name,
        asked: false,
      })),
      ...signIns.forges.map(({ host, name }) => ({
        id: host,
        kind: "forge" as const,
        name,
        asked: false,
      })),
    ],
  };
  writePrivate(join(userData, SIGN_IN_AGAIN_FILE), `${JSON.stringify(file)}\n`);
}

/**
 * Asks for each sign-in still missing here, and takes down each card whose
 * sign-in is here now; the list goes once nothing is left to ask. What
 * cannot be read asks nothing.
 */
export function askSignInsAgain(
  userData: string,
  here: { providers: () => readonly string[]; forges: () => readonly string[] },
  cards: {
    ask: (id: string, signIn: SignInToAsk, from: string) => void;
    clear: (id: string) => void;
  },
): void {
  const path = join(userData, SIGN_IN_AGAIN_FILE);
  if (!existsSync(path)) return;
  let file: SignInsFile;
  try {
    file = fileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return;
  }
  const providers = new Set(here.providers());
  const forges = new Set(here.forges());
  const left: SignInToAsk[] = [];
  for (const signIn of file.signIns) {
    const id = `${SIGN_IN_AGAIN_CARD}${signIn.kind}-${signIn.id}`;
    if ((signIn.kind === "provider" ? providers : forges).has(signIn.id)) {
      cards.clear(id);
      continue;
    }
    if (!signIn.asked) cards.ask(id, signIn, file.from);
    left.push({ ...signIn, asked: true });
  }
  if (!left.length) rmSync(path, { force: true });
  else writePrivate(path, `${JSON.stringify({ ...file, signIns: left })}\n`);
}
