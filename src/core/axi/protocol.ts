import type {
  BrowserActInput,
  BrowserAnswer,
  BrowserCaptureInput,
  BrowserCloseInput,
  BrowserInspectInput,
  BrowserNavigateInput,
} from "../browser/taskBrowsers";

/**
 * What passes between the app and the command process that runs one
 * `infinitary-<tool>-axi` command (docs/axi-commands.md, "The channel"). The app
 * starts the process for one command and sends `run`; the command's table
 * reaches the task's own tool only through `call`, which the app answers
 * for that one task; the process ends with `done`, carrying what the shell
 * prints and its exit code. Nothing here names a task: the app bound the
 * process to the task its key named before it started.
 */

/** The task browser's operations a command may ask for: `CrewmateBrowser`'s, nothing more. */
export type BrowserOp = "navigate" | "inspect" | "act" | "capture" | "close" | "pages";

export type BrowserOpInput = {
  navigate: BrowserNavigateInput;
  inspect: BrowserInspectInput;
  act: BrowserActInput;
  capture: BrowserCaptureInput;
  close: BrowserCloseInput;
  pages: Record<string, never>;
};

/** A browser answer as it crosses into the command process: never the picture's bytes. */
export type ChannelAnswer = Omit<BrowserAnswer, "image">;

/**
 * How the app answered one operation. Within the shell's own limit it is
 * the answer. Past it, the operation keeps running and its answer is kept
 * for the task's next command (`running`), which then gets it instead of
 * running (`earlier`), or hears that it still runs (`busy`): an action is
 * never sent twice.
 */
export type BrowserReply =
  | { kind: "answer"; answer: ChannelAnswer }
  | { kind: "running"; command: string }
  | { kind: "earlier"; command: string; answer: ChannelAnswer }
  | { kind: "busy"; command: string };

/** The app's first and only instruction to a command process. */
export type AxiRunMessage = {
  type: "run";
  /** The command's name as the shell ran it: `infinitary-browser-axi`. */
  tool: string;
  /** Its arguments, as typed. */
  argv: string[];
  /** Where the shell found it, for the home view's path. */
  bin: string;
  /** The working folder the shell ran it in. */
  cwd: string;
  /** The app's version, which every command answers to `-v`. */
  version: string;
};

/** One operation the command asks of the task's tool. */
export type AxiCallMessage = {
  type: "call";
  id: number;
  /** The command as the crewmate named it (`click`), for the words of a kept answer. */
  command: string;
  op: BrowserOp;
  input: unknown;
};

export type AxiResultMessage = { type: "result"; id: number; reply: BrowserReply };

export type AxiDoneMessage = { type: "done"; stdout: string; exitCode: number };

/** From the app to the command process. */
export type AxiParentMessage = AxiRunMessage | AxiResultMessage;

/** From the command process to the app. */
export type AxiChildMessage = AxiCallMessage | AxiDoneMessage;
