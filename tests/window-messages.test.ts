import { readdirSync, readFileSync } from "node:fs";
import { invokeContract } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import { changedMessages } from "../scripts/window-messages.ts";

/**
 * The guardrail INF-2625's plan puts before the window API's channels move
 * out of src/shared/ipc.ts: the journey chooser (scripts/window-messages.ts)
 * still sees a change to every channel the window asks, wherever its entry
 * is written. A chooser that missed an entry would choose no journey for a
 * change to that channel, and nothing else would fail.
 */
describe("the window messages a change edits, on today's contract", () => {
  const root = new URL("../", import.meta.url);
  const read = (file: string) => {
    try {
      return readFileSync(new URL(file, root), "utf8");
    } catch {
      return undefined;
    }
  };
  const channels = new Set<string>(Object.keys(invokeContract));
  const entry = /^ {2}"((?:inf|fm):[^"]+)": \{/gm;
  const modules = (readdirSync(new URL("src/shared/", root), { recursive: true }) as string[])
    .map((path) => `src/shared/${path.split("\\").join("/")}`)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .filter((file) =>
      [...(read(file) ?? "").matchAll(entry)].some((match) => channels.has(match[1] ?? "")),
    );
  // Each of those entries with one more property, so its code changes.
  const edited = new Map(
    modules.map((file) => [
      file,
      (read(file) ?? "").replace(entry, (line, channel: string) =>
        channels.has(channel) ? `${line} guardrail: true,` : line,
      ),
    ]),
  );

  it("names every channel the window's methods ask when each channel's entry changes", () => {
    const messages = changedMessages(modules, (file) => edited.get(file) ?? read(file), read);
    const preload = ["src/preload/api.ts", "src/preload/index.ts"].map(read).join("\n");
    const asked = new Set(
      [...preload.matchAll(/invoke\(\s*"((?:inf|fm):[^"]+)"/g)].map((match) => match[1]),
    );
    expect(asked.size).toBeGreaterThan(0);
    const found = new Set(messages.methods.values());
    expect([...asked].filter((channel) => !found.has(channel ?? ""))).toEqual([]);
  });
});
