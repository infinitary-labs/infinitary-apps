import type { Core } from "@core/index";
import { seedTask } from "@core/tasks/seedTask";

/**
 * INF-2820 piece 2's project-filter part: three projects, each with its own tasks, a tag and an Activity line, and one
 * task waiting on the captain in the second project, so a focus on the first narrows Tasks, the tag row and Activity
 * and counts one waiting elsewhere.
 */
const PROJECTS = [
  {
    name: "north-pier",
    key: "NPR",
    tag: "pilings",
    tasks: ["Survey the north pier pilings", "Chart the north pier depths"],
  },
  { name: "south-pier", key: "SPR", tag: "lamps", tasks: ["Repair the south pier lamp"] },
  { name: "tide-tables", key: "TID", tag: "tables", tasks: ["Publish the spring tide table"] },
] as const;

/** What the part types focused on north-pier and at All projects, and finds again in what the computer received. */
const MESSAGES = {
  focused: "How deep is the water under the north pier?",
  all: "Which pier needs the most work this week?",
} as const;

type Writes = readonly { channel: string; args: unknown[] }[];

/** One control request of this part, or undefined for one it does not own. */
export async function projectFilterCommand(
  core: Core,
  writes: Writes,
  until: (predicate: () => boolean) => Promise<void>,
  command: string,
): Promise<unknown> {
  switch (command) {
    case "project-filter-fixture":
      return { projects: await seedProjects(core), messages: MESSAGES };
    // The part's message as the phone sent it to this computer.
    case "project-filter-sent":
    case "project-filter-sent-all": {
      const text = command === "project-filter-sent" ? MESSAGES.focused : MESSAGES.all;
      const sent = () =>
        writes
          .filter((write) => write.channel === "inf:converse")
          .map((write) => write.args[0] as { text?: string } | undefined)
          .find((payload) => payload?.text === text);
      await until(() => sent() !== undefined);
      return sent();
    }
    default:
      return undefined;
  }
}

/** Added through the setup a person uses, once per home: a later call finds each project by name. */
async function seedProjects(core: Core) {
  const tasks = core.services.tasks;
  const projects: { id: string; name: string; key: string; tag: string; line: string }[] = [];
  for (const { name, key, tag, tasks: titles } of PROJECTS) {
    const repoId =
      core.services.repos.list().find((repo) => repo.name === name)?.id ??
      (await core.dispatch("inf:repos:setup", [{ kind: "init", name, key }])).repo.id;
    const ids = titles.map(
      (title, index) =>
        seedTask(tasks, {
          id: `project-filter-${key.toLowerCase()}-${index}`,
          title,
          // The waiting task is a crewmate's, idle on its decision, as a started task waits on the captain.
          status: key === "SPR" ? "idle" : "queued",
          startPolicy: "on-request",
          repoId,
        }).id,
    );
    const first = ids[0];
    if (!first) throw new Error(`${name} seeded no task`);
    const projectId = tasks.get(first)?.projectId ?? "";
    const words = name.replace("-", " ");
    tasks.changeProjectTags({
      op: "add",
      projectId,
      name: tag,
      description: `Work on the ${words}.`,
    });
    tasks.replaceTags(first, { names: [tag] }, "captain");
    const line = `Checked the ${words} readings`;
    tasks.turns.recordReport(first, { text: line, summary: line });
    if (key === "SPR") {
      const cards = core.services.supervisor.cards;
      cards.emitCrewmateCard(
        first,
        {
          id: "south-pier-lamp",
          title: "Which lamp should the south pier get?",
          body: "<p>The old lamp is rusted through; two replacements fit the post.</p>",
          actions: [
            { id: "led", label: "The LED lamp", default: true },
            { id: "sodium", label: "The sodium lamp" },
          ],
        },
        "crew",
      );
      cards.closeOut({ kind: "crewmate", taskId: first }, "idle");
    }
    projects.push({ id: projectId, name, key, tag, line });
  }
  return projects;
}
