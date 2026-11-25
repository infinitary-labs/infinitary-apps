import * as m from "@shared/i18n/messages.generated";
import type { TaskDetail } from "@shared/tasks";
import { useState } from "react";
import { useProjectTags } from "../app/useProjectTags";
import { RowMenu } from "../design";

/**
 * The record's Tags row on its Info tab (docs/task-tags.md): the tags the
 * task carries, then Edit tags, a menu of the project's tags each ticked on
 * or off. A tick saves at once and leaves the menu open. Drawn only once the
 * project has tags or the task carries one.
 */
export function RecordTags({ detail }: { detail: TaskDetail }) {
  const projectTags = useProjectTags(detail.projectId);
  const carried = detail.tags ?? [];
  const carriedIds = carried.map((tag) => tag.id).join("\n");
  // Ticks sent and not yet read back, so two quick ticks build on each
  // other; they stand only until the record reads a different set.
  const [picked, setPicked] = useState<{ from: string; on: Set<string> } | null>(null);
  const [failed, setFailed] = useState(false);
  if (projectTags.length === 0 && carried.length === 0) return null;
  const on =
    picked && picked.from === carriedIds ? picked.on : new Set(carried.map((tag) => tag.id));
  const flip = (tagId: string) => {
    const next = new Set(on);
    if (next.has(tagId)) next.delete(tagId);
    else next.add(tagId);
    setPicked({ from: carriedIds, on: next });
    setFailed(false);
    const undo = () => {
      setPicked(null);
      setFailed(true);
    };
    window.infinitary.task.tags(detail.id, [...next]).then((result) => {
      if (!result.ok) undo();
    }, undo);
  };
  return (
    <div className="row" data-record-tags-row="">
      <div className="label" data-task-fact-label="">
        {m.recordFactTags()}
      </div>
      <div
        className="title"
        data-task-fact="tags"
        style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}
      >
        <span style={carried.length === 0 ? { color: "var(--fg-3)" } : undefined}>
          {carried.length === 0 ? m.recordTagsNone() : carried.map((tag) => tag.name).join(", ")}
        </span>
        {projectTags.length > 0 && (
          <span data-record-tags="">
            <RowMenu
              label={m.recordTagsEdit()}
              word={m.recordTagsEdit()}
              items={projectTags.map((tag) => ({
                id: tag.id,
                label: tag.name,
                detail: tag.description,
                checked: on.has(tag.id),
                onSelect: () => flip(tag.id),
              }))}
            />
          </span>
        )}
        {failed && (
          <span role="alert" style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}>
            {m.recordTagsFailed()}
          </span>
        )}
      </div>
    </div>
  );
}
