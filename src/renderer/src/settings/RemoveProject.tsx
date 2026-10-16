import {
  REPO_REMOVAL_LINE,
  type RepoView,
  repoRemovalQuestion,
  repoRemovalRefusal,
} from "@shared/repos";
import { useState } from "react";
import { KeyedText } from "../cards/TaskKey";
import { Button } from "../design";

/**
 * The last line of a project's open row (design skill
 * `components/projects/RemoveProject`). Remove first reads the tasks still on
 * the project: any of them is named at once and nothing is asked. Otherwise
 * the line turns into one question with Cancel focused, so Enter never
 * removes. The folder is never touched.
 */
type Phase = { kind: "rest" } | { kind: "checking" } | { kind: "asking" } | { kind: "removing" };

export function RemoveProject({ repo, onRemoved }: { repo: RepoView; onRemoved: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "rest" });
  const [notice, setNotice] = useState<string | null>(null);

  const begin = () => {
    setNotice(null);
    setPhase({ kind: "checking" });
    window.infinitary.repos.removal(repo.id).then(
      ({ tasks }) => {
        if (tasks.length > 0) {
          setNotice(repoRemovalRefusal(repo.name, tasks));
          setPhase({ kind: "rest" });
        } else setPhase({ kind: "asking" });
      },
      () => {
        setNotice("Could not check this project. Please try again.");
        setPhase({ kind: "rest" });
      },
    );
  };

  const remove = () => {
    setPhase({ kind: "removing" });
    window.infinitary.repos.remove(repo.id).then(onRemoved, (caught: unknown) => {
      setNotice(caught instanceof Error ? caught.message : "Could not remove this project.");
      setPhase({ kind: "rest" });
    });
  };

  const asking = phase.kind === "asking" || phase.kind === "removing";
  return (
    <div
      data-remove-project={repo.id}
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
            {repoRemovalQuestion(repo.name, repo.path)}
          </div>
        ) : (
          <>
            <div style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--fg-1)" }}>
              Remove project
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
              {REPO_REMOVAL_LINE}
            </div>
          </>
        )}
        {notice && (
          <div
            role="status"
            data-remove-notice
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
            disabled={phase.kind === "removing"}
            onClick={() => setPhase({ kind: "rest" })}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            pending={phase.kind === "removing"}
            pendingLabel="Removing..."
            onClick={remove}
          >
            Remove
          </Button>
        </span>
      ) : (
        <Button
          variant="danger"
          size="sm"
          disabled={phase.kind === "checking"}
          onClick={begin}
          aria-label={`Remove ${repo.name}`}
        >
          Remove
        </Button>
      )}
    </div>
  );
}
