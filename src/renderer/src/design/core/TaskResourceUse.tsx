import { HERE } from "@shared/deviceNames";
import { loadRunWords } from "@shared/load";
import {
  type ComputerResourcesView,
  RESOURCE_DEMAND_RENEW_MS,
  TASK_USE_EMPTY,
  TASK_USE_UNAVAILABLE,
  taskResourceWords,
} from "@shared/resources";
import { useEffect, useState } from "react";
import { resourcePushes } from "../../plugins/reads/appExecutor";

/** Live facts, not a claim that a quiet model session has stopped its work. */
export function TaskResourceUse({ taskId }: { taskId: string }) {
  const [view, setView] = useState<ComputerResourcesView>();
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
      const label = computer.computerId === null ? HERE.this : computer.label;
      if (!own.length) return [];
      if (computer.load?.status !== "fresh") return [`Run status unavailable on ${label}`];
      return own.map((run) => loadRunWords(run, label));
    }) ?? [];
  const sampled = view?.computers.some(
    (computer) =>
      computer.reading.status === "fresh" &&
      computer.reading.observation.processes?.status === "sampled",
  );
  return (
    <div className="fm-task-facts" data-task-resources="">
      <div className="row">
        <div className="label" data-task-fact-label="">
          Use
        </div>
        <div className="title" data-task-resource-use="" style={{ fontFamily: "var(--font-mono)" }}>
          {shares.length ? shares.join("; ") : sampled ? TASK_USE_EMPTY : TASK_USE_UNAVAILABLE}
        </div>
      </div>
      {runs.length > 0 && (
        <div className="row">
          <div className="label" data-task-fact-label="">
            Run
          </div>
          <div className="title" data-task-load="" style={{ fontFamily: "var(--font-mono)" }}>
            {runs.join("; ")}
          </div>
        </div>
      )}
    </div>
  );
}
