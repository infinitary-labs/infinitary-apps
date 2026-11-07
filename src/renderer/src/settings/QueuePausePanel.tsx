import type { QueueAnswer, RepoView } from "@shared/repos";
import { useState } from "react";
import { Button, Input } from "../design";
import { QUEUE_PAUSE_WORDS } from "./projectsWords";
import { SettingError } from "./settingRows";

const SELECT_STYLE = {
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  background: "var(--surface-input)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-1) var(--space-2)",
} as const;

/**
 * A project's paused batch under "Where changes go" (docs/forge.md, "A
 * paused batch"): when it paused and why, who is repairing it, its issue,
 * and the by-hand answers - Resume, or Send back one change - each with the
 * reason the queue writes on the issue it closes.
 */
export function QueuePausePanel({
  repo,
  pause,
}: {
  repo: Pick<RepoView, "id">;
  pause: NonNullable<RepoView["queuePause"]>;
}) {
  const [reason, setReason] = useState("");
  const [which, setWhich] = useState(String(pause.changes[0] ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const since = new Date(pause.since).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const answer = async (made: QueueAnswer) => {
    setBusy(true);
    setError(null);
    try {
      await window.infinitary.repos.queueAnswer(repo.id, made);
      setSent(true);
      setReason("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  const go = (action: "resume" | "send-back") => {
    const why = reason.trim();
    if (!why) {
      setError(QUEUE_PAUSE_WORDS.needsReason);
      return;
    }
    void answer(
      action === "resume"
        ? { action, run: pause.run, reason: why }
        : { action, run: pause.run, number: Number(which), reason: why },
    );
  };
  return (
    <section
      aria-label={QUEUE_PAUSE_WORDS.title}
      data-queue-pause={repo.id}
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
          {QUEUE_PAUSE_WORDS.title}
        </span>
        <span>{QUEUE_PAUSE_WORDS.summary(pause.run, pause.changes, since)}</span>
        <span data-queue-pause-claim>
          {pause.unread
            ? QUEUE_PAUSE_WORDS.unread
            : pause.claimedBy
              ? QUEUE_PAUSE_WORDS.claimed(pause.claimedBy)
              : QUEUE_PAUSE_WORDS.unclaimed}
        </span>
      </div>
      {pause.url && (
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void window.infinitary.app.openExternal(pause.url).catch(() => {})}
          >
            {pause.unread ? QUEUE_PAUSE_WORDS.run : QUEUE_PAUSE_WORDS.issue}
          </Button>
        </div>
      )}
      <Input
        aria-label={QUEUE_PAUSE_WORDS.reason}
        placeholder={QUEUE_PAUSE_WORDS.reason}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div
        style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}
      >
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          pending={busy}
          onClick={() => go("resume")}
        >
          {QUEUE_PAUSE_WORDS.resume}
        </Button>
        {pause.changes.length > 0 && (
          <>
            <select
              aria-label={QUEUE_PAUSE_WORDS.sendBackWhich}
              value={which}
              onChange={(event) => setWhich(event.target.value)}
              style={SELECT_STYLE}
            >
              {pause.changes.map((number) => (
                <option key={number} value={String(number)}>
                  #{number}
                </option>
              ))}
            </select>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => go("send-back")}>
              {QUEUE_PAUSE_WORDS.sendBack}
            </Button>
          </>
        )}
      </div>
      {sent && <div role="status">{QUEUE_PAUSE_WORDS.sent}</div>}
      <SettingError error={error} surface="queue-pause" />
    </section>
  );
}
