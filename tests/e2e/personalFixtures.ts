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
