/**
 * The shapes a task's browsers take from their host and give their crewmate:
 * the options `TaskBrowsers` is built with and what its wakes carry
 * (docs/task-browser.md).
 */
import type { HostBrowserFrame, HostTaskBrowser } from "../host";
import type { ConnectionGuardHandle, ConnectionGuardOptions, GuardLookup } from "./connectionGuard";
import type {
  BrowserActInput,
  BrowserAnswer,
  BrowserCaptureInput,
  BrowserCloseInput,
  BrowserInspectInput,
  BrowserNavigateInput,
} from "./crewmateCommands";
import type { KeptPages } from "./keptPages";
import type { AnswerProbe } from "./pageAnswers";
import type { PageStarts } from "./pageStarts";
import type { ProjectServer } from "./projectServer";
import type { SignInStore } from "./savedSignInGrants";

/**
 * One task's browser, as its crewmate's command reaches it
 * (`src/core/axi/browserCommands.ts`, through the task's channel).
 */
export type CrewmateBrowser = {
  navigate: (input: BrowserNavigateInput) => Promise<BrowserAnswer>;
  inspect: (input: BrowserInspectInput) => Promise<BrowserAnswer>;
  act: (input: BrowserActInput) => Promise<BrowserAnswer>;
  capture: (input: BrowserCaptureInput) => Promise<BrowserAnswer>;
  close: (input?: BrowserCloseInput) => Promise<BrowserAnswer>;
  /** Every page the browser holds, or that no browser is open; reads nothing on a page. */
  pages: () => Promise<BrowserAnswer>;
};

export type TaskBrowsersOptions = {
  host: HostTaskBrowser;
  /** Where a task's pictures go: its evidence folder, outside the working copy. */
  evidenceDir: (taskId: string) => string;
  /**
   * The task's working copy: the only folder its crewmate may attach a file
   * from when a page asks for one (docs/task-browser.md, "A page that asks
   * for a file"). With none, it attaches nothing.
   */
  workingCopy?: (taskId: string) => string | undefined;
  /** One line on the task's own timeline. */
  note?: (taskId: string, text: string) => void;
  /** A task's browser changed for the captain: it opened, moved, acted or stopped. */
  onChange?: (taskId: string) => void;
  /**
   * The captain returned a task's browser: its crewmate's one wake, named
   * by `once` so the inbox queues it once (docs/task-browser.md, "Taking
   * control").
   */
  onReturned?: (taskId: string, returned: BrowserReturned) => void;
  max?: number;
  idleMs?: number;
  /** Runs `fn` after `ms` and answers its cancel; injected so a test drives the clock. */
  timer?: (ms: number, fn: () => void) => () => void;
  /** This run's name; a fresh one when absent. */
  session?: string;
  /** Starts a browser's connection guard; the real one on loopback when absent. */
  guard?: (options: ConnectionGuardOptions) => Promise<ConnectionGuardHandle>;
  /** How a guard resolves a name; the system's resolver when absent. */
  lookup?: GuardLookup;
  /** The signed-in sites this computer keeps; with none, nothing is kept or offered. */
  signIns?: SignInStore;
  /**
   * The captain's private sites list (docs/task-browser.md, "Private
   * sites"): the home's own, or the one it lends a computer that runs work,
   * read as a task's browser opens and at each of its crewmate's opens.
   * With none, no private site is reached.
   */
  privateSites?: (taskId: string) => readonly string[] | Promise<readonly string[]>;
  /** The time, injected so a test drives which cookies are still alive. */
  now?: () => number;
  /** Serves a project folder for a page the captain opens; the real loopback server when absent. */
  serve?: (folder: string) => Promise<ProjectServer>;
  /**
   * Where each task's stopped page is kept, so a restart reads it as a
   * stopped browser Open again can start (docs/task-browser.md, "After a
   * restart"); with none, a restart forgets it.
   */
  kept?: KeptPages;
  /** Tries a loopback port, as this computer; the real connection attempt when absent. */
  probe?: AnswerProbe;
  /**
   * Nothing answers at the loopback address the captain opened a task's
   * page on, and he waits there (docs/task-browser.md, "When nothing
   * answers"): its crewmate's one wake for that outage, named by `once`.
   * Told at each check while the outage lasts; the inbox queues it once.
   */
  onUnanswered?: (taskId: string, unanswered: PageUnanswered) => void;
  /**
   * The start commands crewmates saved with their pages, which the host
   * runs when nothing answers there (docs/task-browser.md, "Starting a page
   * again"); with none, `--start` is refused and only the crewmate is woken.
   */
  starts?: Pick<
    PageStarts,
    "keep" | "kept" | "starting" | "run" | "stopWithBrowser" | "turn" | "forget" | "stopAll"
  >;
};

/** Nothing answers at a task's page: what its crewmate's one wake for that outage says. */
export type PageUnanswered = {
  /** The page's host and port. */
  site: string;
  /** The page's address, bare of its query and fragment. */
  url: string;
  /** This outage's own name: the run, the task and how many outages it has had. */
  once: string;
  /** The saved start the host ran and how it failed: its exit code, or that its wait ran out. */
  start?: { command: string; exit?: number | null; ranOut?: true; log: string };
};

/**
 * A page from a task's project the captain opens in its browser
 * (docs/task-browser.md, "A page from the project"): the project folder and
 * the HTML file's path inside it.
 */
export type ProjectPage = { folder: string; path: string };

/** The captain handed a task's browser back: what its crewmate's one wake says. */
export type BrowserReturned = {
  /** The page's host and port, as the captain read it. */
  site: string;
  /** What the crewmate said it would do once control came back, when it asked. */
  after?: string;
  /** The captain let it use the signed-in site, rather than signing in. */
  saved?: true;
  /** This return's own name: the run, the browser and how many returns it has had. */
  once: string;
};

/** A watcher's sink: one picture of the page each time it changes. */
export type BrowserFrameSink = (frame: HostBrowserFrame) => void;
