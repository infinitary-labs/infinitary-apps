import { type KeyboardEvent as ReactKeyboardEvent, useState } from "react";
import {
  BOARD_LANE_LABELS,
  BOARD_TAG_LANES,
  type BoardTagChip,
  type BoardTagRow,
} from "./boardTiles";
import * as m from "./messages.generated";

/**
 * The task board's tags (docs/task-board.md; the design skill's
 * `components/now/TaskBoard`, "Its tags" and "By tag"): the tag row under
 * the project chips and Find, and the By tag view's table. Each is one Tab
 * stop, the chip or row focus last rested on, else the pressed chip or the
 * first row.
 */

/** ← → along the tag row and ↑ ↓ along the By tag rows; Home and End go to the ends. */
function roveKey(
  event: ReactKeyboardEvent<HTMLElement>,
  selector: string,
  back: string,
  forward: string,
) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const all = [...event.currentTarget.querySelectorAll<HTMLElement>(selector)];
  const at = all.indexOf(event.target as HTMLElement);
  if (at < 0) return;
  const to =
    event.key === back
      ? Math.max(0, at - 1)
      : event.key === forward
        ? Math.min(all.length - 1, at + 1)
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? all.length - 1
            : null;
  if (to === null) return;
  event.preventDefault();
  all[to]?.focus();
}

const chipKey = (id: string | null) => id ?? "all";

/** All tags, each tag with its count, then No tag, in the project chips' look; nothing while no tags apply. */
export function BoardTagChips({
  chips,
  held,
  onPress,
}: {
  chips: readonly BoardTagChip[];
  held: string | null;
  onPress: (tagId: string | null) => void;
}) {
  const [at, setAt] = useState<string | null>(null);
  if (chips.length === 0) return null;
  const stop = chips.some((chip) => chipKey(chip.id) === at) ? at : chipKey(held);
  return (
    <div
      className="fm-board-chips fm-board-tags"
      data-board-tags=""
      role="toolbar"
      aria-label={m.nowPanelTags()}
      onKeyDown={(event) => roveKey(event, "[data-board-tag]", "ArrowLeft", "ArrowRight")}
    >
      {chips.map((chip) => (
        <button
          key={chipKey(chip.id)}
          type="button"
          className="fm-board-chip"
          data-board-tag={chipKey(chip.id)}
          aria-pressed={held === chip.id ? "true" : "false"}
          tabIndex={chipKey(chip.id) === stop ? 0 : -1}
          onFocus={() => setAt(chipKey(chip.id))}
          onClick={() => onPress(chip.id)}
        >
          {chip.label}
          {chip.count !== null && (
            <span className="fm-board-tag-n" data-board-tag-count="">
              {chip.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Each tag and No tag against the five lanes, whole counts; a row opens the Board view on its tag. */
export function BoardTagTable({
  rows,
  onOpen,
}: {
  rows: readonly BoardTagRow[];
  onOpen: (tagId: string) => void;
}) {
  const [at, setAt] = useState<string | null>(null);
  const stop = rows.some((row) => row.id === at) ? at : (rows[0]?.id ?? null);
  return (
    <table
      className="fm-board-tag-table"
      data-board-tag-table=""
      aria-label={m.nowPanelBoardTagsTable()}
    >
      <thead>
        <tr>
          <th scope="col" className="fm-board-lane-label">
            {m.nowPanelTags()}
          </th>
          {BOARD_TAG_LANES.map((name) => (
            <th key={name} scope="col" className="fm-board-lane-label">
              {BOARD_LANE_LABELS[name]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody onKeyDown={(event) => roveKey(event, "[data-board-tag-row]", "ArrowUp", "ArrowDown")}>
        {rows.map((row) => (
          <tr key={row.id} data-board-tag-line={row.id} onClick={() => onOpen(row.id)}>
            <th scope="row">
              <button
                type="button"
                className="fm-board-tag-name"
                data-board-tag-row={row.id}
                tabIndex={row.id === stop ? 0 : -1}
                onFocus={() => setAt(row.id)}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen(row.id);
                }}
              >
                {row.name}
              </button>
            </th>
            {BOARD_TAG_LANES.map((name) => (
              <td
                key={name}
                data-board-tag-cell={name}
                data-board-zero={row.counts[name] === 0 ? "" : undefined}
              >
                {row.counts[name]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
