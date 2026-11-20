import type { Scenario, ScenarioAnswer } from "../mockProvider";
import { calledTool, latestServedTurn, sinceLastUser } from "../providerRequest";

/**
 * A program run to its result in the launched app (INF-799 piece 2, the
 * captain's "Keep it held for a journey" on INF-812; INF-3022, a crewmate
 * starts it). Hermetic replay, not a claim that a live model writes
 * programs: the captain's words name the project, the stand-in first mate
 * spawns one crewmate with the nudge "use start_program to do this", that
 * crewmate starts the program with start_program, each part's stand-in
 * crewmate, recognised by its Goal line since a part carries no words of
 * the captain's, reports its answer - the finder with a typed result, the two
 * parts after it with text - and the crewmate that started it reports once
 * the program's end steers it.
 */
export const PROGRAM_RUN_PROMPT = "run the meter capping program";
/** The crewmate's task the first mate spawns. */
export const CREW_TITLE = "Cap the meter's results with a program";
const CREW_GOAL = "Cap what the meter renders, through one program.";
/** The first mate's nudge: it names the tool and writes no script (INF-3022). */
export const NUDGE = "Use start_program to do this.";
export const PROGRAM_TITLE = "Cap the meter's rendered results";
/** What the crewmate reports once its program's end steers it. */
export const CREW_REPORT = "The program capped both renderers at 4 KiB.";
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
/** INF-974: a bounded lookup is low; applying its recipe is medium. */
export const FIND_INTELLIGENCE = "low";
export const CAP_INTELLIGENCE = "medium";
/** The capping part's report for one file. */
export const capped = (file: string) => `Capped ${file} at 4 KiB.`;
export const PROGRAM_SCRIPT = `
await phase("find");
const found = await task(${JSON.stringify(FIND_PROMPT)}, { label: "find", intelligence: ${JSON.stringify(FIND_INTELLIGENCE)}, schema: ${JSON.stringify(FILES_SCHEMA)} });
await phase("cap");
const done = await Promise.all(found.files.map((file) => task(${JSON.stringify(CAP_PROMPT)} + " " + file + ".", { after: ["find"], intelligence: ${JSON.stringify(CAP_INTELLIGENCE)} })));
return { files: found.files, capped: done };
`;
/** The bound the crewmate proposes: one finder and one part per file. */
export const PROGRAM_BOUND = FILES.length + 1;

/**
 * The project the captain's own words name, as `project <id>`. Only their
 * segment is read: the host's context part beside it has its own prose,
 * such as the project scopes note, and that is not the captain naming one.
 */
function captainProject(body: string): string {
  const words = (latestServedTurn(body)?.segments ?? [])
    .filter((segment) => segment.kind === "user" && segment.origin === "captain")
    .map((segment) => segment.body)
    .join("\n");
  return words.match(/project (\S+)/)?.[1] ?? "missing";
}

const report = (text: string, result?: Record<string, unknown>): ScenarioAnswer => ({
  calls: [{ name: "report", args: { text, ...(result ? { result } : {}) } }],
});

export const programRun: Scenario = () => {
  return ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (!wantsStream) return undefined;
    if (isFirstmate) {
      const { user, results } = sinceLastUser(body);
      if (!user.includes("[user]") || !user.includes(PROGRAM_RUN_PROMPT)) return undefined;
      if (results.length > 0) return { text: "A crewmate starts the capping program." };
      return {
        calls: [
          {
            name: "spawn_crewmate",
            args: {
              title: CREW_TITLE,
              goal: CREW_GOAL,
              user_words: PROGRAM_RUN_PROMPT,
              repo_id: captainProject(body),
              constraints: [{ kind: "free", text: NUDGE }],
            },
          },
        ],
      };
    }
    // A part carries no words of the captain's: each is recognised by its own Goal line.
    if (body.includes(`Goal: ${FIND_PROMPT}`)) {
      if (calledTool(latestUserTail, "report")) return { text: "Reported my part." };
      return report("Found two renderers.", { files: FILES });
    }
    const file = FILES.find((name) => body.includes(`Goal: ${CAP_PROMPT} ${name}.`));
    if (file) {
      if (calledTool(latestUserTail, "report")) return { text: "Reported my part." };
      return report(capped(file));
    }
    if (!body.includes(`Goal: ${CREW_GOAL}`)) return undefined;
    // The program's end steers the crewmate that started it: it reads the result and reports.
    if (sinceLastUser(body).user.includes("Your program")) {
      if (calledTool(latestUserTail, "report")) return { text: "Reported the program's result." };
      return report(CREW_REPORT);
    }
    if (calledTool(latestUserTail, "start_program"))
      return { text: "Started the program; its end steers me." };
    return {
      calls: [
        {
          name: "start_program",
          args: {
            title: PROGRAM_TITLE,
            goal: "Cap what the meter renders, part by part.",
            script: PROGRAM_SCRIPT,
            bound: PROGRAM_BOUND,
          },
        },
      ],
    };
  };
};
