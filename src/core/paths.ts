import { join } from "node:path";
import { LOCAL_DOOR_FOLDER } from "../shared/connection";
import { PHONE_DOOR_FOLDER } from "../shared/phoneLink";

/** The personal workspace's fleet-root name; the repo registry refuses it for anything else. */
export const PERSONAL_WORKSPACE_NAME = "personal";

/**
 * Every app-scoped location under Electron's userData dir. Pi is pointed
 * exclusively at these paths - it never reads ~/.pi (docs/architecture.md
 * section 5).
 */
export type AppPaths = {
  userData: string;
  /** Provider credentials (0600) and custom model definitions. */
  authDir: string;
  authPath: string;
  modelsPath: string;
  /** The account-keyed store matrix: accounts/<providerId>/<accountId>/. */
  accountsDir: string;
  /**
   * The app's own sign-ins where projects live (git integration PR 1.2):
   * one 0700 directory per host, never the account vault's tree.
   */
  forgesDir: string;
  /**
   * Integrations' own settings (docs/integrations.md): one 0700 folder
   * written only by `IntegrationsService`; no sign-in is kept there.
   */
  integrationsDir: string;
  /**
   * Pairing (docs/devices.md): the home's key and the list of paired
   * devices, 0700 with every file 0600, written only by `DevicePairing`.
   */
  devicesDir: string;
  /**
   * The website sign-ins the captain saved on this Mac for task browsers
   * (docs/task-browser.md, "Saved sign-ins"): 0700, one 0600 file per site,
   * written only by `WebSignIns`.
   */
  webSignInsDir: string;
  /**
   * The captain's private sites list for task browsers on every computer
   * (docs/task-browser.md, "Private sites"): one 0600 file, written only by
   * `PrivateSites`.
   */
  privateSitesFile: string;
  /**
   * The freeze recorder's bounded record (docs/freeze-recorder.md): one
   * JSON line per main thread stall, written only by its watchdog thread.
   */
  freezeRecordPath: string;
  /**
   * The freeze recorder's per-version tally (docs/freeze-recorder.md, "The
   * per-version tally"): every stall of each installed version, written
   * only by the main thread.
   */
  freezeTallyPath: string;
  /**
   * The freeze recorder's minute pass record (docs/freeze-recorder.md, "The
   * minute pass's steps"): one JSON line per pass with each step's timing,
   * written only by its watchdog thread.
   */
  passRecordPath: string;
  /**
   * The freeze recorder's memory reading (docs/freeze-recorder.md, "The
   * memory reading"): one JSON line per reading of the main process's memory.
   */
  memoryRecordPath: string;
  /**
   * The panels' log (docs/personal-panels.md, "The panel log"): every line a
   * panel's code logs or prints and the host's own lines about panels,
   * appended only by `PanelLog`, moved aside to `panels.old.log` past its
   * bound.
   */
  panelLogPath: string;
  /**
   * The task channel's keys (docs/axi-commands.md, "The channel"): 0700,
   * one 0600 file per task granted a command, emptied each time the app
   * opens and closes the channel, written only by `AxiChannel`.
   */
  taskChannelDir: string;
  /**
   * The phone's door (docs/devices.md, "A phone that joins by its address"):
   * 0700, its loopback address and key in two 0600 files, emptied each time
   * the app opens and closes the door, written only by `PhoneDoor`. Its name
   * is `PHONE_DOOR_FOLDER`, where the phone's fixed command looks.
   */
  phoneDoorDir: string;
  /**
   * The local door (docs/connection.md, "The local door"): 0700, the
   * connection's loopback address, the pin of the door's own TLS key and a
   * key in three 0600 files, written each time the connection starts and removed when it
   * closes, only by the connection. The window on this computer reads them.
   */
  localDoorDir: string;
  /** Pi's agentDir: app-scoped config root, never ~/.pi/agent. */
  piAgentDir: string;
  /** Per-crewmate session dirs: crewmates/<taskId>/sessions/. */
  crewmatesDir: string;
  /** Worktree-per-task area (decision D-8). */
  worktreesDir: string;
  /**
   * Retired worktrees awaiting deletion: moved here in one rename so a
   * settle never waits on deleting the tree; emptied in the background.
   */
  worktreeTrashDir: string;
  /**
   * Warm working copies between tasks (the worktree pool): a closed task's
   * tree, saved and reset clean with its dependencies kept, parked here
   * until the next task on the same repository takes it. Same volume as
   * the worktrees area, so parking and taking one are renames.
   */
  worktreePoolDir: string;
  /**
   * The app-owned fleet root: the canonical home/index for every managed
   * repo. Clone/init create real directories here; adopt links an in-place
   * external repo from here.
   */
  fleetDir: string;
  /**
   * The personal workspace (talk-to-personalize Step 2): a git repo the app
   * seeds and keeps healthy, holding the captain's personal extensions. It
   * sits in the fleet root so it is a project like any other, under a name
   * the repo registry reserves for it.
   */
  personalWorkspaceDir: string;
  /** Compiled personal-extension modules, content-addressed, served to panel frames. */
  personalCacheDir: string;
  /**
   * The installed plugins (one plugin vehicle, Phase A): one directory per
   * plugin the captain consented to, pinned at install. The app writes it
   * only through the installer; nothing an installed plugin ships runs in
   * the core or the main process.
   */
  pluginsDir: string;
  /** Installs waiting on the captain's consent card, one directory per plugin id. */
  pluginsStagingDir: string;
  /**
   * An installed panel's compiled graph, content-addressed like the personal
   * cache. The frame realm (Phase A item 4) serves it, as it does every panel.
   */
  installedCacheDir: string;
  /** The app-managed default local-only repo for repo-less tasks. */
  defaultWorkspaceDir: string;
  /** The Firstmate agent's neutral cwd - never a project or worktree. */
  firstmateHomeDir: string;
  /** The Firstmate agent's rolling session dir (captain decision Q4). */
  firstmateSessionsDir: string;
  /** The Claude-served seat's own transcript copies and sidecars (W1 S6). */
  firstmateClaudeDir: string;
  /** The supervision session's neutral cwd (design B) - never a project. */
  supervisionHomeDir: string;
  /** The supervision session's rolling session dir. */
  supervisionSessionsDir: string;
  /** Full text spilled here when a message-length cap truncates it (capWithOverflow). */
  overflowDir: string;
  /** Message-owned copies of an accepted message's pictures (`src/core/attachments.ts`). */
  attachmentsDir: string;
  /**
   * The experimental knowledge collection (docs/knowledge.md): its own
   * database, opened only by an alpha or development build. A stable build
   * never opens, reads or deletes it.
   */
  knowledgeDir: string;
};

export function appPathsFor(userData: string): AppPaths {
  return {
    userData,
    authDir: join(userData, "auth"),
    authPath: join(userData, "auth", "auth.json"),
    modelsPath: join(userData, "auth", "models.json"),
    accountsDir: join(userData, "accounts"),
    forgesDir: join(userData, "forges"),
    integrationsDir: join(userData, "integrations"),
    devicesDir: join(userData, "devices"),
    webSignInsDir: join(userData, "web-sign-ins"),
    privateSitesFile: join(userData, "private-sites.json"),
    freezeRecordPath: join(userData, "freezes.jsonl"),
    freezeTallyPath: join(userData, "freeze-tally.json"),
    passRecordPath: join(userData, "minute-passes.jsonl"),
    memoryRecordPath: join(userData, "memory.jsonl"),
    panelLogPath: join(userData, "logs", "panels.log"),
    taskChannelDir: join(userData, "task-channel"),
    phoneDoorDir: join(userData, PHONE_DOOR_FOLDER),
    localDoorDir: join(userData, LOCAL_DOOR_FOLDER),
    piAgentDir: join(userData, "pi-agent"),
    crewmatesDir: join(userData, "crewmates"),
    worktreesDir: join(userData, "worktrees"),
    worktreeTrashDir: join(userData, "worktree-trash"),
    worktreePoolDir: join(userData, "worktree-pool"),
    fleetDir: join(userData, "fleet"),
    personalWorkspaceDir: join(userData, "fleet", PERSONAL_WORKSPACE_NAME),
    personalCacheDir: join(userData, "cache", "personal"),
    pluginsDir: join(userData, "plugins"),
    pluginsStagingDir: join(userData, "plugins-staging"),
    installedCacheDir: join(userData, "cache", "installed"),
    defaultWorkspaceDir: join(userData, "default-workspace"),
    firstmateHomeDir: join(userData, "firstmate", "home"),
    firstmateSessionsDir: join(userData, "firstmate", "sessions"),
    firstmateClaudeDir: join(userData, "firstmate", "claude"),
    supervisionHomeDir: join(userData, "supervision", "home"),
    supervisionSessionsDir: join(userData, "supervision", "sessions"),
    overflowDir: join(userData, "overflow"),
    attachmentsDir: join(userData, "attachments"),
    knowledgeDir: join(userData, "knowledge"),
  };
}

export function crewmateSessionsDir(paths: AppPaths, taskId: string): string {
  return join(paths.crewmatesDir, taskId, "sessions");
}

/**
 * The host's copies of the pictures a crewmate's cards show (card pictures,
 * phase 2): `crewmates/<taskId>/cards/`, served by the frame scheme's
 * `images` host. It lives and dies with the task's folder: the removal of a
 * closed task's leftover files keeps it (`tasks/closedTaskFiles.ts`), and
 * only the Settings purge takes it.
 */
export function crewmateCardPicturesDir(paths: AppPaths, taskId: string): string {
  return join(paths.crewmatesDir, taskId, "cards");
}

/**
 * A crewmate's evidence folder: `crewmates/<taskId>/evidence/`, on this
 * machine and outside every project. Pictures, transcripts and logs the
 * crewmate gathers live here, never in its working copy, so none of it can
 * be committed; a card may show a picture from it by absolute path, and
 * keeps its own copy. It goes a week after the task closes, unless live
 * work still builds on the task (`tasks/closedTaskFiles.ts`).
 */
export function crewmateEvidenceDir(paths: AppPaths, taskId: string): string {
  return join(paths.crewmatesDir, taskId, "evidence");
}

/**
 * A task's temporary folder: `crewmates/<taskId>/temp/`, beside evidence.
 * Bulk working material goes here. The app removes a folder it provisioned
 * when the task closes; evidence keeps its own week (`tasks/taskTemp.ts`).
 */
export function crewmateTempDir(paths: AppPaths, taskId: string): string {
  return join(paths.crewmatesDir, taskId, "temp");
}

/**
 * The verified copies of the files a task's reports hand on (INF-992):
 * `crewmates/<taskId>/handover-out/`, each 0600, kept until the first
 * mate's steer delivers them and removed when the task closes.
 */
export function crewmateHandoverDir(paths: AppPaths, taskId: string): string {
  return join(paths.crewmatesDir, taskId, "handover-out");
}

/**
 * What the home keeps about a crewmate's conversation held on a computer that
 * runs work (src/core/placed/): `crewmates/<taskId>/placed/`, with the answer
 * to every callback it asked (`calls.jsonl`), change ids synced before their
 * effects (`begun.jsonl`), and the newest event the home keeps (`state.json`).
 */
export function crewmatePlacedDir(paths: AppPaths, taskId: string): string {
  return join(paths.crewmatesDir, taskId, "placed");
}

/** Author-editable card bodies, separate from host picture copies and evidence. */
export function crewmateCardBodiesDir(paths: AppPaths, taskId: string): string {
  return join(paths.crewmatesDir, taskId, "card-bodies");
}

/**
 * The cards a crewmate's brief hands it from the tasks its work is grounded
 * in or was discovered from (FI3-700): `crewmates/<taskId>/source-cards/`,
 * one whole card body per source task, written when the brief is minted and
 * named in it, so the brief carries a path instead of the card's HTML.
 */
export function crewmateSourceCardsDir(paths: AppPaths, taskId: string): string {
  return join(paths.crewmatesDir, taskId, "source-cards");
}
