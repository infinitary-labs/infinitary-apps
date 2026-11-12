import { HERE } from "@shared/deviceNames";
import * as m from "@shared/i18n/messages.generated";
import { loadRunWords } from "@shared/load";
import {
  type ComputerResourcesView,
  RESOURCE_DEMAND_RENEW_MS,
  TASK_USE_EMPTY,
  TASK_USE_UNAVAILABLE,
  taskResourceWords,
} from "@shared/resources";
import { useEffect, useState } from "react";
import { useHereAs } from "../../devices/useFirstMatePlace";
import { resourcePushes } from "../../plugins/reads/appExecutor";
import { RecordCell } from "./TaskFacts";

/**
 * What the task uses on each computer and the runs it holds in the load
 * line, as cells of the task record's row of facts. Live facts, not a claim
 * that a quiet model session has stopped its work.
 */
export function TaskResourceUse({ taskId }: { taskId: string }) {
  const [view, setView] = useState<ComputerResourcesView>();
  // The first mate's own computer, named from one that controls it.
  const here = useHereAs();
  useEffect(() => {
    let live = true;
    let generation = 0;
    const stop = resourcePushes((value) => {
      generation++;
      if (live) setView(value);
    });
    const read = () => {
      const requested = ++generation;
      void window.infinitary.plugins
        .read("computers.resources", {})
        .then((value) => {
          if (live && generation === requested) setView(value);
        })
        .catch(() => {
          if (live && generation === requested) setView(undefined);
        });
    };
    read();
    const timer = window.setInterval(read, RESOURCE_DEMAND_RENEW_MS);
    return () => {
      live = false;
      stop();
      window.clearInterval(timer);
    };
  }, []);
  const shares =
    view?.computers.flatMap((computer) => {
      const reading = computer.reading;
      if (reading.status !== "fresh" || reading.observation.processes?.status !== "sampled")
        return [];
      const share = reading.observation.processes.tasks.find((task) => task.taskId === taskId);
      return share ? [`${computer.label} · ${taskResourceWords(share)}`] : [];
    }) ?? [];
  const runs =
    view?.computers.flatMap((computer) => {
      const own = computer.load?.runs.filter((run) => run.taskId === taskId) ?? [];
      const label = computer.computerId === null ? here(HERE.this) : computer.label;
      if (!own.length) return [];
      if (computer.load?.status !== "fresh")
        return [m.uiTaskResourceRunUnavailable({ computer: label })];
      return own.map((run) => loadRunWords(run, label));
    }) ?? [];
  const sampled = view?.computers.some(
    (computer) =>
      computer.reading.status === "fresh" &&
      computer.reading.observation.processes?.status === "sampled",
  );
  const use = shares.length ? shares.join("; ") : sampled ? TASK_USE_EMPTY : TASK_USE_UNAVAILABLE;
  // Cells in the record's row of facts, beside Runs on (INF-2261, the
  // captain's pick: "A Use cell beside Runs on, dim mono"), and the run the
  // load line holds for the task beside it.
  return (
    <>
      <RecordCell label={m.uiTaskResourceUse()} dim data-task-resource-use="">
        {use}
      </RecordCell>
      {runs.length > 0 && (
        <RecordCell label={m.uiTaskResourceRun()} dim data-task-load="">
          {runs.join("; ")}
        </RecordCell>
      )}
    </>
  );
}
