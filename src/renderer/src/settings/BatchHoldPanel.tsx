import type { BatchAnswer, OpenBatch } from "@shared/batches";
import { changeNumberLabel } from "@shared/forge";
import { formatTime } from "@shared/i18n/format";
import type { RepoView } from "@shared/repos";
import { useState } from "react";
import { Button, Input } from "../design";
import { BATCH_HOLD_WORDS } from "./projectsWords";
import { SettingError } from "./settingRows";

/**
 * A held batch of the captain's own approved changes under "Where changes
 * go" (docs/forge.md, "A held batch"): since when and why, its pull
 * request, and the by-hand answers - Try again, or Send back the chosen
 * changes, each with the reason its crewmate reads. Every control is
 * reached with Tab and pressed with Space or Enter.
 */
export function BatchHoldPanel({
  repo,
  batch,
}: {
  repo: Pick<RepoView, "id" | "host">;
  batch: OpenBatch & { hold: NonNullable<OpenBatch["hold"]> };
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState<BatchAnswer["action"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const hold = batch.hold;
  const since = formatTime(hold.at, { hour: "numeric", minute: "2-digit" });
  const summary =
    hold.reason === "checks"
      ? BATCH_HOLD_WORDS.checks(since, hold.checks, batch.members.length)
      : hold.reason === "rules"
        ? BATCH_HOLD_WORDS.rules(since)
        : hold.detail
          ? BATCH_HOLD_WORDS.refused(since, hold.detail)
          : BATCH_HOLD_WORDS.noWay(since);
  const answer = async (made: BatchAnswer, words: string) => {
    setBusy(made.action);
    setError(null);
    setDone(null);
    try {
      await window.infinitary.repos.batchAnswer(repo.id, made);
      setDone(words);
      setChosen([]);
      setReasons({});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };
  const sendBack = () => {
    if (chosen.length === 0) {
      setError(BATCH_HOLD_WORDS.needsChange);
      return;
    }
    const changes = chosen.map((taskId) => ({ taskId, reason: (reasons[taskId] ?? "").trim() }));
    if (changes.some((change) => !change.reason)) {
      setError(BATCH_HOLD_WORDS.needsReason);
      return;
    }
    void answer(
      { action: "send-back", head: hold.head, changes },
      BATCH_HOLD_WORDS.sentBack(changes.length),
    );
  };
  const url = batch.url;
  return (
    <section
      aria-label={BATCH_HOLD_WORDS.title}
      data-batch-hold={repo.id}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        marginBottom: "var(--space-3)",
        padding: "var(--space-3)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-m)",
        background: "var(--warn-dim)",
        fontSize: "var(--text-xs)",
        color: "var(--fg-2)",
      }}
    >
      <div
        role="status"
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}
      >
        <span style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--fg-1)" }}>
          {BATCH_HOLD_WORDS.title}
        </span>
        <span data-batch-hold-summary>{summary}</span>
      </div>
      <div
        style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}
      >
        <Button
          variant="primary"
          size="sm"
          disabled={busy !== null}
          pending={busy === "try-again"}
          onClick={() =>
            void answer({ action: "try-again", head: hold.head }, BATCH_HOLD_WORDS.retried)
          }
        >
          {BATCH_HOLD_WORDS.tryAgain}
        </Button>
        {url && batch.number !== undefined && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void window.infinitary.app.openExternal(url).catch(() => {})}
          >
            {BATCH_HOLD_WORDS.open(changeNumberLabel(repo.host?.kind, batch.number))}
          </Button>
        )}
      </div>
      <fieldset
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
          margin: 0,
          padding: 0,
          border: "none",
        }}
      >
        <legend style={{ padding: 0, paddingBottom: "var(--space-1)", color: "var(--fg-2)" }}>
          {BATCH_HOLD_WORDS.changes}
        </legend>
        {batch.members.map((member) => {
          const picked = chosen.includes(member.taskId);
          return (
            <div
              key={member.taskId}
              data-batch-member={member.taskId}
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}
            >
              <label
                style={{
                  display: "flex",
                  gap: "var(--space-2)",
                  alignItems: "center",
                  color: "var(--fg-1)",
                }}
              >
                <input
                  type="checkbox"
                  checked={picked}
                  onChange={(event) =>
                    setChosen((current) =>
                      event.target.checked
                        ? [...current, member.taskId]
                        : current.filter((taskId) => taskId !== member.taskId),
                    )
                  }
                />
                <span>{member.title}</span>
              </label>
              {picked && (
                <Input
                  aria-label={BATCH_HOLD_WORDS.reason(member.title)}
                  placeholder={BATCH_HOLD_WORDS.reasonPlaceholder}
                  value={reasons[member.taskId] ?? ""}
                  onChange={(event) =>
                    setReasons((current) => ({ ...current, [member.taskId]: event.target.value }))
                  }
                />
              )}
            </div>
          );
        })}
      </fieldset>
      <div>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy !== null}
          pending={busy === "send-back"}
          onClick={sendBack}
        >
          {BATCH_HOLD_WORDS.sendBack}
        </Button>
      </div>
      {done && <div role="status">{done}</div>}
      <SettingError error={error} surface="batch-hold" />
    </section>
  );
}
