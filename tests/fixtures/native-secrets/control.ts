import { chmod } from "node:fs/promises";
import { createServer } from "node:net";

/** Fixed views of existing metadata; no arbitrary selector or value reaches the renderer. */
export const FIXTURE_AREAS = ["uses", "rules", "history", "recovery"] as const;
export type FixtureArea = (typeof FIXTURE_AREAS)[number];

/** INF-1109: own-window proof controls, never evaluation, text entry or authentication. */
export const FIXTURE_COMMANDS = [
  "status",
  "capture",
  "prepare",
  "settings",
  "secrets",
  ...FIXTURE_AREAS,
  "review",
  "allow-once",
  "deny",
  "backup",
  "restore",
  "unlock",
  "quit",
] as const;
export type FixtureCommand = (typeof FIXTURE_COMMANDS)[number];
export type FixtureSurface = {
  confirming: () => boolean;
  status: () => Promise<unknown>;
  perform: (command: Exclude<FixtureCommand, "status">) => Promise<unknown>;
};

export function fixtureControls(surface: FixtureSurface): (input: string) => Promise<unknown> {
  let acting = false;
  return async (input) => {
    if (!FIXTURE_COMMANDS.some((command) => command === input))
      return { refused: "Unknown control." };
    const command = input as FixtureCommand;
    // Status contains metadata only. No input, capture or second action while
    // a human owns the native confirmation or another action is unfinished.
    if (command === "status") return surface.status();
    if (acting || surface.confirming())
      return { refused: "A fixture action or native confirmation is pending." };
    acting = true;
    try {
      return await surface.perform(command);
    } finally {
      acting = false;
    }
  };
}

export const UNREADABLE_FIXTURE_REPLY =
  "No readable fixture reply; check its state before repeating any action.";

/** A closed connection is not a reply, and a reply is not a completed native effect. */
export function decodeFixtureReply(text: string): {
  value: Record<string, unknown>;
  refused: boolean;
} {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(UNREADABLE_FIXTURE_REPLY);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(UNREADABLE_FIXTURE_REPLY);
  return { value: value as Record<string, unknown>, refused: Object.hasOwn(value, "refused") };
}

/** Call with cwd at the owned fixture folder: Darwin's socket path is length-limited. */
export async function serveFixtureControls(run: (input: string) => Promise<unknown>) {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let command = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      command += chunk;
      // The finite request vocabulary supplies its own physical framing bound.
      if (!FIXTURE_COMMANDS.some((allowed) => allowed.startsWith(command))) socket.destroy();
    });
    socket.once("end", () => {
      if (socket.destroyed) return;
      void run(command).then(
        (result) => socket.end(JSON.stringify(result)),
        () =>
          socket.end(
            JSON.stringify({
              refused:
                "The fixture could not finish that control; do not repeat an uncertain action.",
            }),
          ),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen("control.sock", resolve);
  });
  await chmod("control.sock", 0o600);
  return server;
}
