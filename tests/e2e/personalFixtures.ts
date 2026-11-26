import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appPathsFor } from "../../src/core/paths";

/**
 * INF-2394 measure 4: personal-workspace fixtures share the production path and panel format owner.
 * @journey-area src/core/personal/
 * @journey-area src/core/panels/
 */
export function seedPersonalWorkspace(
  userDataDir: string,
  source: string,
  name?: string,
  filter?: (source: string) => boolean,
): string {
  const workspace = appPathsFor(userDataDir).personalWorkspaceDir;
  mkdirSync(workspace, { recursive: true });
  cpSync(source, name ? join(workspace, name) : workspace, {
    recursive: true,
    ...(filter ? { filter } : {}),
  });
  return workspace;
}

/** The clocks use the real skill source, varying only the city and the declared placement. */
export function seedClockPanels(
  userDataDir: string,
  cities: readonly { title: string; zone: string }[],
): void {
  const workspace = appPathsFor(userDataDir).personalWorkspaceDir;
  for (const [index, city] of cities.entries()) {
    const dir = join(workspace, `clock-${index}`);
    mkdirSync(dir, { recursive: true });
    cpSync("tests/fixtures/personal-skills/tokyo-clock/panel.tsx", join(dir, "panel.tsx"));
    writeFileSync(
      join(dir, "panel.tsx"),
      readFileSync(join(dir, "panel.tsx"), "utf8").replace("Asia/Tokyo", city.zone),
    );
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        title: city.title,
        placement: { x: "left", y: index === 4 ? "bottom" : "top" },
        order: index,
        presence: { always: true },
      }),
    );
  }
}

/** INF-2205: a real panel process wedges during spin, rather than faking the stopped signal. */
export function seedUnresponsivePanel(workspace: string): void {
  const spinner = join(workspace, "spinner");
  mkdirSync(spinner);
  writeFileSync(
    join(spinner, "manifest.json"),
    JSON.stringify({ title: "Spinner", api: 2, placement: { x: "left", y: "top" } }),
  );
  writeFileSync(
    join(spinner, "panel.tsx"),
    [
      'import type { PanelProps } from "@infinitary/contracts";',
      "export default function Panel({ id }: PanelProps) {",
      "  return <p data-fixture={id} style={{ margin: 0 }}>spinning up</p>;",
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(spinner, "server.ts"),
    [
      "export const actions = {",
      '  ping: () => "pong",',
      "  spin: () => {",
      "    for (;;) {}",
      "  },",
      "};",
    ].join("\n"),
  );
}

/**
 * The captain's plan for the panel status mark: a panel whose background job
 * fails every run, as the one that showed the gap did when its connector's
 * daily read limit ran out, while the panel still drew what it last read.
 * The job runs at the shortest cadence the app allows, so two failed runs
 * span the app's window on the journeys' short tick. Its `raise-limit`
 * action stands for the limit coming back: the next run works.
 */
/** What each failed run answers: the error's own message, as the panel process reports it. */
export const FAILING_READ_ANSWER = "429 Too Many Requests: the connector allows 150 reads a day";
export function seedFailingReadPanel(workspace: string): void {
  const growth = join(workspace, "growth");
  mkdirSync(growth);
  writeFileSync(
    join(growth, "manifest.json"),
    JSON.stringify({ title: "Growth", api: 2, placement: { x: "left", y: "top" }, order: 0 }),
  );
  writeFileSync(
    join(growth, "panel.tsx"),
    [
      'import type { PanelProps } from "@infinitary/contracts";',
      "export default function Panel({ id }: PanelProps) {",
      "  return <p data-fixture={id} style={{ margin: 0 }}>Visitors, Nov 22: 1,284</p>;",
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(growth, "server.ts"),
    [
      "let limited = true;",
      "export const actions = {",
      '  "raise-limit": () => {',
      "    limited = false;",
      "    return true;",
      "  },",
      "};",
      "export const background = {",
      "  refresh: {",
      "    everyMs: 60_000,",
      "    run: async () => {",
      `      if (limited) throw new Error(${JSON.stringify(FAILING_READ_ANSWER)});`,
      "    },",
      "  },",
      "};",
    ].join("\n"),
  );
}

/**
 * A panel written before the panel API's store answered asynchronously
 * (INF-2470): its manifest names no `api`, and its `server.ts` reads
 * `context.db` as if it answered at once, as such panels were written.
 * `updateOlderApiPanel` makes the change its update makes: every call
 * awaited and `"api": 2`.
 */
export function seedOlderApiPanel(workspace: string): void {
  const counter = join(workspace, "counter");
  mkdirSync(counter);
  writeFileSync(
    join(counter, "manifest.json"),
    JSON.stringify({ title: "Counter", placement: { x: "left", y: "top" } }),
  );
  writeFileSync(
    join(counter, "panel.tsx"),
    [
      'import type { PanelProps } from "@infinitary/contracts";',
      "export default function Panel({ id }: PanelProps) {",
      "  return <p data-fixture={id} style={{ margin: 0 }}>Counted today</p>;",
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(counter, "server.ts"),
    [
      'import type { ServerContext } from "@infinitary/contracts";',
      "export const actions = {",
      "  count: (_input: unknown, context: ServerContext) => {",
      '    const n = (context.db.get("n") as unknown as number | undefined) ?? 0;',
      '    context.db.set("n", n + 1);',
      "    return n + 1;",
      "  },",
      "};",
    ].join("\n"),
  );
}

/** The older panel as its update leaves it: every store call awaited, written for API 2. */
export function updateOlderApiPanel(workspace: string): void {
  const counter = join(workspace, "counter");
  writeFileSync(
    join(counter, "server.ts"),
    [
      'import type { ServerContext } from "@infinitary/contracts";',
      "export const actions = {",
      "  count: async (_input: unknown, context: ServerContext) => {",
      '    const n = ((await context.db.get("n")) as number | undefined) ?? 0;',
      '    await context.db.set("n", n + 1);',
      "    return n + 1;",
      "  },",
      "};",
    ].join("\n"),
  );
  writeFileSync(
    join(counter, "manifest.json"),
    JSON.stringify({ api: 2, title: "Counter", placement: { x: "left", y: "top" } }),
  );
}

/**
 * INF-2817: a panel whose code writes a line each way a panel can - through
 * `context.log` and on both of its process's streams - and whose process
 * ends on its own once asked, printing a last line as it goes. Each line is
 * named once here, where it goes in and where a journey looks for it.
 */
export const CHATTY_LINES = {
  logged: "chatty handed a line to context.log",
  printed: "chatty printed a line on its output",
  warned: "chatty printed a line on its errors",
  last: "chatty printed its last line before ending",
} as const;

export function seedChattyPanel(workspace: string): void {
  const chatty = join(workspace, "chatty");
  mkdirSync(chatty);
  writeFileSync(
    join(chatty, "manifest.json"),
    JSON.stringify({ title: "Chatty", api: 2, placement: { x: "left", y: "top" } }),
  );
  writeFileSync(
    join(chatty, "panel.tsx"),
    [
      'import type { PanelProps } from "@infinitary/contracts";',
      "export default function Panel({ id }: PanelProps) {",
      "  return <p data-fixture={id} style={{ margin: 0 }}>Chatty</p>;",
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(chatty, "server.ts"),
    [
      'import type { ServerContext } from "@infinitary/contracts";',
      "export const actions = {",
      "  talk: (_input: unknown, context: ServerContext) => {",
      `    context.log(${JSON.stringify(CHATTY_LINES.logged)});`,
      `    console.log(${JSON.stringify(CHATTY_LINES.printed)});`,
      `    console.error(${JSON.stringify(CHATTY_LINES.warned)});`,
      '    return "said";',
      "  },",
      "  end: () => {",
      `    process.stderr.write(${JSON.stringify(`${CHATTY_LINES.last}\n`)}, () => process.exit(3));`,
      '    return "ending";',
      "  },",
      "};",
    ].join("\n"),
  );
}
