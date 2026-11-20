import { type FilesAnswer, type FilesReadInput, filesAnswerSchema } from "@shared/files";

/**
 * The files command as one task reaches it (docs/files.md): the computers it
 * may name, one folder's listing on another of them, and one file copied
 * into the task's hand-over folder. The home answers every one: for a
 * crewmate of its own directly (`FileRouter.forTask`), and for one on a
 * computer that runs work through that computer, which asks the home each
 * time (`filesAskedOfHome`). Each answer is rows or a refusal's words.
 */
export type TaskFiles = {
  computers: (signal?: AbortSignal) => Promise<FilesAnswer>;
  list: (target: string, signal?: AbortSignal) => Promise<FilesAnswer>;
  copy: (target: string, signal?: AbortSignal) => Promise<FilesAnswer>;
};

/** What a computer that runs work asks its home for the files command, by work request. */
export type AskHomeForFiles = {
  read: (input: FilesReadInput, signal?: AbortSignal) => Promise<unknown>;
  copy: (target: string, signal?: AbortSignal) => Promise<unknown>;
};

/**
 * The files command on a computer that runs work: each list and copy asked
 * of the home (`inf:work:files`, `inf:work:copy-file`), which reads the file
 * where it is and delivers its copy into the task's hand-over folder here.
 */
export function filesAskedOfHome(ask: AskHomeForFiles): TaskFiles {
  return {
    computers: async (signal) =>
      filesAnswerSchema.parse(await ask.read({ op: "computers" }, signal)),
    list: async (target, signal) =>
      filesAnswerSchema.parse(await ask.read({ op: "list", target }, signal)),
    copy: async (target, signal) => filesAnswerSchema.parse(await ask.copy(target, signal)),
  };
}
