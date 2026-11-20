import * as m from "@shared/i18n/messages.generated";
import type { RepoMoveResult, RepoMoveTarget, RepoView } from "@shared/repos";
import { useState } from "react";
import { KeyedText } from "../cards/TaskKey";
import { Button } from "../design";
import { FIRSTMATE_SELECT_STYLE } from "./GeneralTab";
import type { GroupProject } from "./projectGroups";

/** The select's value for "A project of its own" - never a task key, which is 2-4 letters or digits. */
const OWN = "\u0000own";

/**
 * The Move line just above Remove on a repository's settings (design skill
 * `components/projects/MoveRepository`, INF-5005's part 2). A project is
 * chosen from every other live project, or a project of its own when the
 * repository shares its project; Move then turns the line into one question
 * with Cancel focused, so Enter never moves. Its Move runs the same
 * `inf:repos:move` the move card applies, at once on the captain's click.
 */
type Phase = { kind: "rest" } | { kind: "asking" } | { kind: "moving" };

export function MoveRepository({
  repo,
  targets,
  ownOffered,
  onMoved,
}: {
  repo: RepoView;
  /** Every other live project that holds a repository, Scratch and the personal workspace left out. */
  targets: GroupProject[];
  /** A project of its own is offered when the repository shares its project. */
  ownOffered: boolean;
  onMoved: (moved: RepoMoveResult) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "rest" });
  const [chosen, setChosen] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const target = targets.find((project) => project.key === chosen);
  const own = chosen === OWN && ownOffered;
  const ready = Boolean(target) || own;

  const move = () => {
    const to: RepoMoveTarget = own ? { own: true } : chosen;
    setPhase({ kind: "moving" });
    window.infinitary.repos.move([repo.id], to).then(onMoved, (caught: unknown) => {
      setNotice(caught instanceof Error ? caught.message : m.settingsProjectsMoveFailed());
      setPhase({ kind: "rest" });
    });
  };

  const asking = phase.kind === "asking" || phase.kind === "moving";
  const question = own
    ? m.projectsMoveTitleOwn({ repositories: repo.name })
    : m.projectsMoveTitleInto({ repositories: repo.name, project: target?.name ?? "" });
  return (
    <div
      data-move-repository={repo.id}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "10px 0",
        borderTop: "1px solid var(--line-1)",
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        {asking ? (
          <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
            {question} {m.settingsProjectsMoveQuestion()}
          </div>
        ) : (
          <>
            <div style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--fg-1)" }}>
              {m.settingsProjectsMoveNamed({ name: repo.name })}
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
              {m.settingsProjectsMoveLine()}
            </div>
          </>
        )}
        {notice && (
          <div
            role="status"
            data-move-notice
            style={{ fontSize: "var(--text-xs)", color: "var(--danger)", paddingTop: 4 }}
          >
            <KeyedText text={notice} />
          </div>
        )}
      </div>
      {asking ? (
        <span style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <Button
            variant="secondary"
            size="sm"
            autoFocus
            disabled={phase.kind === "moving"}
            onClick={() => setPhase({ kind: "rest" })}
          >
            {m.settingsProjectsRemoveCancel()}
          </Button>
          <Button
            variant="primary"
            size="sm"
            pending={phase.kind === "moving"}
            pendingLabel={m.settingsProjectsMoving()}
            onClick={move}
          >
            {m.settingsProjectsMoveConfirm()}
          </Button>
        </span>
      ) : (
        <span style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
          <select
            value={chosen}
            aria-label={m.settingsProjectsMoveTarget({ name: repo.name })}
            onChange={(event) => {
              setChosen(event.target.value);
              setNotice(null);
            }}
            style={FIRSTMATE_SELECT_STYLE}
          >
            <option value="">{m.settingsProjectsMoveChoose()}</option>
            {targets.map((project) => (
              <option key={project.id} value={project.key}>
                {project.name}
              </option>
            ))}
            {ownOffered && <option value={OWN}>{m.settingsProjectsMoveOwn()}</option>}
          </select>
          <Button
            variant="secondary"
            size="sm"
            disabled={!ready}
            onClick={() => {
              setNotice(null);
              setPhase({ kind: "asking" });
            }}
          >
            {m.settingsProjectsMoveConfirm()}
          </Button>
        </span>
      )}
    </div>
  );
}
