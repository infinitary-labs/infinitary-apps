import { calledTool, type Scenario, type ScenarioAnswer, sinceLastUser } from "../mockProvider";

/**
 * A program run to its result in the launched app (INF-799 piece 2, the
 * captain's "Keep it held for a journey" on INF-812). Hermetic replay, not
 * a claim that a live model writes programs: the captain's words name the
 * project, the stand-in first mate files one program with create_task, and
 * each part's stand-in crewmate reports its answer - the finder with a
 * typed result, the two parts after it with text.
 */
export const PROGRAM_RUN_PROMPT = "run the meter capping program";
export const PROGRAM_TITLE = "Cap the meter's rendered results";
/** Each part is told apart by its own goal, the script's prompt, which only its brief carries. */
export const FIND_PROMPT = "Find where the meter renders a result, for the program journey.";
export const CAP_PROMPT = "Cap the result rendered in";
/** What the finder hands on, the shape its result must fit. */
export const FILES = ["src/meter.ts", "src/gauge.ts"];
const FILES_SCHEMA = {
  type: "object",
  required: ["files"],
  properties: { files: { type: "array", items: { type: "string" } } },
};
/** The capping part's report for one file. */
export const capped = (file: string) => `Capped ${file} at 4 KiB.`;
export const PROGRAM_SCRIPT = `
await phase("find");
const found = await task(${JSON.stringify(FIND_PROMPT)}, { label: "find", schema: ${JSON.stringify(FILES_SCHEMA)} });
await phase("cap");
const done = await Promise.all(found.files.map((file) => task(${JSON.stringify(CAP_PROMPT)} + " " + file + ".", { after: ["find"] })));
return { files: found.files, capped: done };
`;
/** The bound the first mate proposes: one finder and one part per file. */
export const PROGRAM_BOUND = FILES.length + 1;

/** The project the captain's words name, as `project <id>`. */
const projectIn = (words: string) => words.match(/project (\S+)/)?.[1] ?? "missing";
const report = (text: string, result?: Record<string, unknown>): ScenarioAnswer => ({
  calls: [{ name: "report", args: { text, ...(result ? { result } : {}) } }],
});

export const programRun: Scenario = () => {
  return ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (!wantsStream) return undefined;
    if (isFirstmate) {
      const { user, results } = sinceLastUser(body);
      if (!user.includes("[user]") || !user.includes(PROGRAM_RUN_PROMPT)) return undefined;
      if (results.length > 0) return { text: "Filed the capping program." };
      return {
        calls: [
          {
            name: "create_task",
            args: {
              title: PROGRAM_TITLE,
              goal: "Cap what the meter renders, part by part.",
              user_words: PROGRAM_RUN_PROMPT,
              repo_id: projectIn(user),
              start_policy: "when-ready",
              blocked_by: [],
              program: { script: PROGRAM_SCRIPT, bound: PROGRAM_BOUND },
            },
          },
        ],
      };
    }
    if (!body.includes(PROGRAM_RUN_PROMPT)) return undefined;
    if (calledTool(latestUserTail, "report")) return { text: "Reported my part." };
    if (body.includes(`Goal: ${FIND_PROMPT}`))
      return report("Found two renderers.", { files: FILES });
    const file = FILES.find((name) => body.includes(`Goal: ${CAP_PROMPT} ${name}.`));
    return file ? report(capped(file)) : undefined;
  };
};
