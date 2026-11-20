import { LEFT_OUT_WORDS } from "../batches/combine";
import type { TaskRecord } from "../storage/taskRecords";
import { TaskGraph } from "../tasks/taskGraph";
import { TaskService } from "../tasks/taskService";
import { git } from "../workspace/git";
import { candidateHead } from "./mergeAuthorization";

/**
 * The part a task was built on (`shape.built_on`) and that part's newest
 * approved version, while the part is live, unmerged and approved to merge
 * (docs/task-graph.md, "Following the part under it"). `from` is the version
 * the task's recorded base names now. Undefined for a task built on no part,
 * or once that part merged, closed or lost its approval: those are the
 * batch line's and the idle ladder's other rules.
 */
export function newestBase(
  tasks: TaskService,
  record: Pick<TaskRecord, "shape"> | undefined,
): { task: TaskRecord; branch: string; from: string; newest: string } | undefined {
  const builtOn = tasks.graph.unmergedBuiltOn(record);
  if (!builtOn || TaskService.isClosed(builtOn.task)) return undefined;
  const approval = builtOn.task.delivery?.mergeAuthorization;
  if (!approval || !TaskGraph.approvedToMerge(builtOn.task)) return undefined;
  return {
    task: builtOn.task,
    branch: approval.target.branch,
    from: builtOn.head,
    newest: candidateHead(approval),
  };
}

/**
 * Follow the part under a task at a version of the task the host observes
 * (docs/task-graph.md, "Following the part under it"): when `head` holds the
 * newest approved version of the part the task was built on, the task's
 * recorded base moves to that version through its one writer; when it does
 * not, the batch line's own words say why that version cannot merge, which
 * a merge card refuses with. Undefined when nothing stands in the way,
 * including a `head` this checkout does not hold, which the batch line
 * still checks when it combines.
 */
export async function followBase(
  tasks: TaskService,
  taskId: string,
  head: string,
): Promise<string | undefined> {
  const record = tasks.get(taskId);
  const base = newestBase(tasks, record);
  const builtOn = record?.shape?.built_on;
  if (!record?.repoDir || !base || !builtOn) return undefined;
  const held = await holds(record.repoDir, head, base.newest);
  if (held === null) return undefined;
  if (!held) return LEFT_OUT_WORDS.behindBase(base.newest);
  if (base.newest !== base.from)
    tasks.placement.setBuiltOn(taskId, { ...builtOn, head: base.newest });
  return undefined;
}

/**
 * Whether `head` builds on `ancestor`; null when `head` is not a commit in
 * this checkout. A commit the checkout holds comes with every commit it
 * builds on, so an `ancestor` missing here is one `head` does not build on.
 */
async function holds(repoDir: string, head: string, ancestor: string): Promise<boolean | null> {
  const here = await git(repoDir, ["cat-file", "-e", `${head}^{commit}`]).then(
    () => true,
    () => false,
  );
  if (!here) return null;
  return git(repoDir, ["merge-base", "--is-ancestor", ancestor, head]).then(
    () => true,
    () => false,
  );
}
