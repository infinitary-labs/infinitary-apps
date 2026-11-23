import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Core } from "@core/index";
import type { PersonalExtensionView, PersonalSnapshot } from "@shared/personal/manifest";
import { budgetTimer } from "./budgets";

/**
 * Builds the panel library this checkout makes, as the app's build makes it. The test home runs inside a
 * development module runner, whose NODE_ENV would make the library's JSX call React's development runtime, which a
 * production library does not carry, so no panel would import; the build sees "production" while it runs.
 */
export async function buildPanelLibrary(dir: string) {
  const { buildFrameLib } = await import("../../scripts/frame-lib");
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    return { dir, pins: await buildFrameLib(join(import.meta.dirname, "..", ".."), dir) };
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}

/** The fixture panel the phone's Panels journey draws (tests/fixtures/phone-panels/phone-tally). */
export const PHONE_PANEL_ID = "phone-tally";
/** The fixture panel that decides for itself whether it shows (tests/fixtures/phone-panels/phone-shy). */
export const PHONE_SHY_ID = "phone-shy";

/** A runbook of the captain's own whose one panel is the panel-cards fixture (docs/runbooks.md, "Panels"). */
export const PHONE_RUNBOOK_ID = "phone-desk";
/** That panel's id: its runbook's and its folder's. */
export const PHONE_RUNBOOK_PANEL_ID = `${PHONE_RUNBOOK_ID}-reading`;

/**
 * INF-3830 piece 2's phone part: the computer's side of the Panels journey
 * (ios/Infinitary/InfinitaryUITests/PhoneJourney+Panels.swift). The real core
 * serves its panels, files and library to the phone; these put the fixture
 * panel in the captain's workspace and take it away, write its data and its
 * note card's from the computer, end its background work, change a library
 * file the build made and read what the computer holds.
 */
export function phonePanelControls(
  core: Core,
  /** The library the computer serves, which these build on first use: its pins are filled in place. */
  frameLib: { dir: string; pins: Record<string, string> },
) {
  const folder = join(core.paths.personalWorkspaceDir, PHONE_PANEL_ID);
  const runbook = join(core.paths.personalWorkspaceDir, "runbooks", PHONE_RUNBOOK_ID);
  const listedAs = async (id: string): Promise<PersonalExtensionView | undefined> =>
    ((await core.dispatch("inf:plugins:personal:list", [])) as PersonalSnapshot).extensions.find(
      (extension) => extension.id === id,
    );
  const listed = () => listedAs(PHONE_PANEL_ID);
  /** Waits until what the computer holds says what the journey needs, read again as each push on the channel lands. */
  const whenHeard = async <T>(
    pushed: string,
    read: () => Promise<T>,
    check: (value: T) => boolean,
    failure: string,
  ) => {
    if (check(await read())) return;
    await new Promise<void>((resolve, reject) => {
      const off = core.events.subscribe((channel) => {
        if (channel !== pushed) return;
        void read().then((value) => {
          if (!check(value)) return;
          timer.cancel();
          off();
          resolve();
        });
      });
      const timer = budgetTimer(() => {
        off();
        reject(new Error(failure));
      }, 60_000);
    });
  };
  const until = (
    check: (panel: PersonalExtensionView | undefined) => boolean,
    failure: string,
    id = PHONE_PANEL_ID,
  ) => whenHeard("inf:plugins:personal", () => listedAs(id), check, failure);
  // The library file the journey changes: the boot module every panel's frame loads first.
  const boot = join(frameLib.dir, "boot.mjs");
  let built: Promise<Buffer> | undefined;
  const library = () => {
    built ??= buildPanelLibrary(frameLib.dir).then(({ pins }) => {
      Object.assign(frameLib.pins, pins);
      return readFileSync(boot);
    });
    return built;
  };
  return {
    async seed() {
      await library();
      cpSync(join(process.cwd(), "tests", "fixtures", "phone-panels", PHONE_PANEL_ID), folder, {
        recursive: true,
      });
      await until(
        (panel) => Boolean(panel?.frame && panel.server),
        "The fixture panel was not built",
      );
      return { ok: true };
    },
    /** The panel that decides for itself, which starts out saying it does not show. */
    async seedShy() {
      await library();
      cpSync(
        join(process.cwd(), "tests", "fixtures", "phone-panels", PHONE_SHY_ID),
        join(core.paths.personalWorkspaceDir, PHONE_SHY_ID),
        { recursive: true },
      );
      await until((panel) => Boolean(panel?.frame), "The shy panel was not built", PHONE_SHY_ID);
      return { ok: true };
    },
    /** The computer writes whether the shy panel shows; its own code reads it and says so. */
    async showShy(show: boolean) {
      await core.dispatch("inf:plugins:db", [
        { op: "set", extensionId: PHONE_SHY_ID, key: "show", value: show },
      ]);
      return { ok: true };
    },
    /**
     * Waits until the shy panel's own page has said whether it shows: it writes what it said to its store, so the
     * computer hears that its page ran on the phone, out of sight.
     */
    async shySaid(shown: boolean) {
      const said = async () =>
        (
          (await core.dispatch("inf:plugins:db", [
            { op: "get", extensionId: PHONE_SHY_ID, key: "said" },
          ])) as { value?: unknown }
        ).value;
      await whenHeard(
        "inf:plugins:db",
        said,
        (value) => value === shown,
        "The shy panel's page never said",
      );
      return { ok: true };
    },
    /** The captain's own runbook, written off and then turned on, so its panel shows only while it is on. */
    async runbookOn() {
      await library();
      cpSync(
        join(process.cwd(), "tests", "fixtures", "panel-cards", "reading-list"),
        join(runbook, "reading"),
        { recursive: true },
      );
      writeFileSync(
        join(runbook, "runbook.json"),
        JSON.stringify({
          id: PHONE_RUNBOOK_ID,
          name: "Phone desk",
          description: "Keeps a reading list beside your work.",
          author: "You",
          version: "1.0.0",
          panels: ["reading"],
          startsOff: true,
        }),
      );
      await core.dispatch("inf:settings:runbooks:set", [PHONE_RUNBOOK_ID, true]);
      await until(
        (panel) => Boolean(panel?.frame),
        "The runbook's panel was not built",
        PHONE_RUNBOOK_PANEL_ID,
      );
      return { ok: true };
    },
    async runbookOff() {
      await core.dispatch("inf:settings:runbooks:set", [PHONE_RUNBOOK_ID, false]);
      await until(
        (panel) => panel === undefined,
        "The runbook's panel stayed after it was turned off",
        PHONE_RUNBOOK_PANEL_ID,
      );
      rmSync(runbook, { recursive: true, force: true });
      return { ok: true };
    },
    async removeShy() {
      rmSync(join(core.paths.personalWorkspaceDir, PHONE_SHY_ID), { recursive: true, force: true });
      await until((panel) => panel === undefined, "The shy panel was not forgotten", PHONE_SHY_ID);
      return { ok: true };
    },
    async remove() {
      rmSync(folder, { recursive: true, force: true });
      await until((panel) => panel === undefined, "The fixture panel was not forgotten");
      return { ok: true };
    },
    /** The computer writes the panel's tally itself, as its own background work would. */
    async write(tally: number) {
      await core.dispatch("inf:plugins:db", [
        { op: "set", extensionId: PHONE_PANEL_ID, key: "tally", value: tally },
      ]);
      return { ok: true };
    },
    /** The computer writes what the panel's note card shows (`noted`), while the card shows on the phone's Home. */
    async note(noted: number) {
      await core.dispatch("inf:plugins:db", [
        { op: "set", extensionId: PHONE_PANEL_ID, key: "noted", value: noted },
      ]);
      return { ok: true };
    },
    /** Its background work ends on its own; the computer records the stop. */
    async quit() {
      await core.dispatch("inf:plugins:invoke", [PHONE_PANEL_ID, "quit", null]);
      await until(
        (panel) => panel?.stopped?.reason === "exited",
        "The panel's background work did not stop",
      );
      return { ok: true };
    },
    async tamperLibrary() {
      await library();
      writeFileSync(boot, "fetch('https://example.com');\n");
      return { ok: true };
    },
    async restoreLibrary() {
      writeFileSync(boot, await library());
      return { ok: true };
    },
    async state() {
      const panel = await listed();
      const tally = (await core.dispatch("inf:plugins:db", [
        { op: "get", extensionId: PHONE_PANEL_ID, key: "tally" },
      ])) as { value?: unknown };
      return {
        listed: panel !== undefined,
        stopped: panel?.stopped?.reason ?? null,
        tally: tally.value ?? null,
      };
    },
  };
}
