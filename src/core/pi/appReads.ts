import { automationSpecSchema } from "@shared/automation";
import type { CoreInvokeChannel, InvokeRequest } from "@shared/ipc";
import {
  type AnyCommandId,
  type Bindings,
  bindingLabel,
  COMMAND_IDS,
  KEYBOARD_COMMANDS,
  keysOf,
} from "@shared/keyboard";
import {
  isChanged,
  type KeymapSnapshot,
  resolveBindings,
  type SavedKeymap,
  type SavedKeymapRead,
} from "@shared/keymap";
import type { KeySystem } from "@shared/platform";
import { type ReadName, readCatalog } from "@shared/reads";
import { DEFAULT_USAGE_QUERY, USAGE_TASK_PAGE } from "@shared/usage";
import { z } from "zod";
import type { CoreDispatch } from "../dispatcher";

/**
 * The first mate's named reads (INF-5326's piece 3): what Settings shows that
 * the action list's current values leave out, read on demand through
 * `app_state`'s `read`, never added to the context a turn builds.
 *
 * A read the window's read catalog already names (`readCatalog`,
 * src/shared/reads.ts) is run through that entry's own args and request, so
 * the first mate and a panel read the same thing the same way. The rest read
 * a core channel Settings already asks, and are the first mate's alone: a
 * catalog entry would also open them to panels, which is a separate choice.
 */
type AppRead = {
  /** What it answers, as `area: "reads"` lists it. */
  about: string;
  args: z.ZodType;
  defaults?: Record<string, unknown>;
  run: (dispatch: CoreDispatch, args: unknown, host: ReadHost) => Promise<unknown>;
};

/** What a read knows of the home beyond its requests. */
export type ReadHost = {
  /** The home's system (`host.app.platform`); a Mac's unless named. */
  platform?: string;
  /** The window's installed keys (`HostCapabilities.installedKeys`); null or absent with no window open. */
  installedKeys?: () => KeymapSnapshot | null;
};

function fromCatalog(name: ReadName, defaults?: Record<string, unknown>): AppRead {
  const entry = readCatalog[name];
  return {
    about: entry.description,
    args: entry.args,
    ...(defaults ? { defaults } : {}),
    run: (dispatch, args) =>
      dispatch(
        entry.channel,
        (entry.toRequest as (a: unknown, grant: object) => unknown[])(args, {}),
      ),
  };
}

function overChannel<C extends CoreInvokeChannel>(
  about: string,
  channel: C,
  args: z.ZodType,
  toRequest: (args: never) => InvokeRequest<C>,
): AppRead {
  return {
    about,
    args,
    run: (dispatch, value) => dispatch(channel, toRequest(value as never)),
  };
}

const deviceArgs = z.strictObject({ id: z.string().min(1).max(64) });

/**
 * The keys each command has now, as Keyboard settings lists them. With a
 * window it is the map the window installed, the panels' commands and the
 * keys they displaced included (`source: "installed"`); with none it is the
 * captain's saved keys resolved for the app's own commands alone
 * (`source: "saved"`), which a panel's key may since have displaced.
 */
async function keyboardKeys(dispatch: CoreDispatch, host: ReadHost): Promise<unknown> {
  const system: KeySystem = (host.platform ?? "darwin") === "darwin" ? "mac" : "ctrl";
  const installed = host.installedKeys?.();
  let saved: SavedKeymap;
  let unreadable: boolean;
  let bindings: Bindings;
  if (installed) ({ saved, unreadable, bindings } = installed);
  else {
    const read: SavedKeymapRead = await dispatch("inf:settings:keys:get", []);
    ({ saved, unreadable } = read);
    bindings = resolveBindings(saved, [], system);
  }
  const command = (id: AnyCommandId, label: string, panel?: string) => ({
    id,
    label,
    ...(panel ? { panel } : {}),
    keys: keysOf(bindings, id).map((binding) => bindingLabel(binding, system)),
    changed: isChanged(saved, id),
  });
  return {
    source: installed ? "installed" : "saved",
    preset: saved.preset,
    unreadable,
    commands: [
      ...COMMAND_IDS.map((id) => command(id, KEYBOARD_COMMANDS[id].label)),
      ...(installed?.panels ?? []).map((entry) => command(entry.id, entry.label, entry.panel)),
    ],
  };
}

export const APP_READS = {
  "usage.summary": fromCatalog("usage.summary", DEFAULT_USAGE_QUERY),
  "usage.tasks": fromCatalog("usage.tasks", { ...DEFAULT_USAGE_QUERY, limit: USAGE_TASK_PAGE }),
  "usage.taskCosts": fromCatalog("usage.taskCosts", { period: DEFAULT_USAGE_QUERY.period }),
  "automation.history": fromCatalog("automation.history"),
  "automation.kept": fromCatalog("automation.kept"),
  "update.status": fromCatalog("update.status"),
  "computers.resources": fromCatalog("computers.resources"),
  "automation.preview": overChannel(
    "The next dates a schedule would run, for a spec shaped as automation-edit's.",
    "inf:automation:preview",
    z.strictObject({ spec: automationSpecSchema }),
    (args: { spec: z.infer<typeof automationSpecSchema> }) => [args.spec],
  ),
  "keyboard.keys": {
    about:
      "Each keyboard command's keys as Keyboard settings shows them and whether the captain changed them; source saved means no window installed them, so a panel's key may differ. Read only: the keys are the captain's to change.",
    args: z.strictObject({}),
    run: (dispatch, _args, host) => keyboardKeys(dispatch, host),
  },
  "devices.copies": overChannel(
    "Where each computer's copy of the record stands, and another first mate answering with this one's number.",
    "inf:standby:list",
    z.strictObject({}),
    () => [],
  ),
  "devices.copy-ready": overChannel(
    "What taking over on a computer that keeps a copy lacks, by its deviceId.",
    "inf:standby:ready",
    deviceArgs,
    (args: { id: string }) => [args.id],
  ),
  "devices.move-ready": overChannel(
    "What moving the first mate to a computer lacks, by its deviceId.",
    "inf:home-move:ready",
    deviceArgs,
    (args: { id: string }) => [args.id],
  ),
} satisfies Record<string, AppRead>;

export type AppReadName = keyof typeof APP_READS;
export const APP_READ_NAMES = Object.keys(APP_READS) as AppReadName[];

/**
 * The reads, as `app_state` answers `area: "reads"`: each one's name, what it
 * answers and its args. They are listed on demand rather than in the tool's
 * own words, which every request carries.
 */
export function appReadList(): string {
  return JSON.stringify(
    APP_READ_NAMES.map((name) => {
      const read: AppRead = APP_READS[name];
      return {
        read: name,
        about: read.about,
        args: read.args.toJSONSchema(),
        ...(read.defaults ? { defaults: read.defaults } : {}),
      };
    }),
  );
}

/** Runs one named read; a name off the list or args it refuses answers words, never a read. */
export async function runAppRead(
  dispatch: CoreDispatch,
  name: string,
  raw: unknown,
  host: ReadHost = {},
): Promise<string> {
  if (!Object.hasOwn(APP_READS, name)) return `No read "${name}". Reads: ${appReadList()}`;
  const read: AppRead = APP_READS[name as AppReadName];
  // Only args left out read as Settings opens them; args that are not one
  // object are refused before any default is merged, never read as none.
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw)))
    return `The read ${name} refused its args: they must be one object. Args: ${JSON.stringify(read.args.toJSONSchema())}`;
  const parsed = read.args.safeParse({ ...read.defaults, ...(raw as object | undefined) });
  if (!parsed.success)
    return `The read ${name} refused its args: ${z.prettifyError(parsed.error)} Args: ${JSON.stringify(read.args.toJSONSchema())}`;
  try {
    return JSON.stringify({ read: name, value: await read.run(dispatch, parsed.data, host) });
  } catch (error) {
    return `The read ${name} could not answer: ${error instanceof Error ? error.message : String(error)}`;
  }
}
