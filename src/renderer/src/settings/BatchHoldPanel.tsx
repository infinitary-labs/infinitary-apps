import {
  type BatchAnswer,
  batchHoldState,
  batchRepairOf,
  crewHolds,
  type OpenBatch,
} from "@shared/batches";
import { changeNumberLabel, forgePlace } from "@shared/forge";
import { formatTime } from "@shared/i18n/format";
import type { RepoView } from "@shared/repos";
import { type CSSProperties, type ReactNode, useState } from "react";
import { useShellStore } from "../app/store";
import { useBoardTasks } from "../character/crew/useCrewBoard";
import { Button, Input } from "../design";
import { openTask } from "../plugins/point/openTask";
import { BATCH_HOLD_WORDS, BATCH_WAIT_WORDS } from "./projectsWords";
import { SettingError } from "./settingRows";

/**
 * A held batch of the captain's own approved changes under "Where changes
 * go" (docs/forge.md, "A held batch"): who has its next step - its repair,
 * a rule, the captain or no one (`batchHoldState`) - with the repair's
 * latest report, since when and why, its pull request, and the by-hand
 * answers - Try again, or Send back the chosen changes, each with the
 * reason its crewmate reads. The answers lead only while no repair is
 * working on it or a setting refuses the merge; otherwise they fold under
 * Answer it yourself, and the box takes a plain background while the crew
 * has the hold. Every control is reached with Tab and pressed with Space
 * or Enter.
 */
export function BatchHoldPanel({
  repo,
  batch,
  fixes,
}: {
  repo: Pick<RepoView, "id" | "host">;
  batch: OpenBatch & { hold: NonNullable<OpenBatch["hold"]> };
  /** The project's declared fixes (`BatchRecord.fixes`), which mark a repair fixing it. */
  fixes: readonly string[] | undefined;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<string[]>([]);
  const { busy, error, setError, done, send } = useBatchAnswer(repo.id);
  const board = useBoardTasks();
  const hold = batch.hold;
  const repair = batchRepairOf(batch, fixes);
  const row = repair ? board.find((task) => task.id === repair.taskId) : undefined;
  const state = batchHoldState({
    reason: hold.reason,
    repair: repair ?? null,
    awaitsFix: Boolean(batch.awaits),
    passed: batch.passed?.head === batch.head,
    task: row
      ? {
          status: row.status,
          waitingCardId: row.waitingCardId,
          ...(row.waitingCardMerges ? { waitingCardMerges: true } : {}),
        }
      : null,
  });
  const key = row?.key ?? null;
  const who = BATCH_HOLD_WORDS.who(state, key);
  const report =
    row?.outcomeSummary && crewHolds(state) && state !== "passed" ? row.outcomeSummary : null;
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
    if (!(await send(made, words))) return;
    setChosen([]);
    setReasons({});
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
  // Try again and Send back lead only while the next step is the captain's here.
  const leads = state === "setting" || state === "none";
  const tryAgain = (primary: boolean) => (
    <Button
      variant={primary ? "primary" : "secondary"}
      size="sm"
      disabled={busy !== null}
      pending={busy === "try-again"}
      onClick={() =>
        void answer({ action: "try-again", head: hold.head }, BATCH_HOLD_WORDS.retried)
      }
    >
      {BATCH_HOLD_WORDS.tryAgain}
    </Button>
  );
  const answers: ReactNode = (
    <>
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
    </>
  );
  return (
    <section
      aria-label={BATCH_HOLD_WORDS.title}
      data-batch-hold={repo.id}
      data-batch-hold-state={state}
      style={panelStyle(crewHolds(state) ? "var(--bg-2)" : "var(--warn-dim)")}
    >
      <div
        role="status"
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}
      >
        <span style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--fg-1)" }}>
          {BATCH_HOLD_WORDS.heldTitle(state)}
        </span>
        {who && (
          <span data-batch-hold-who style={{ fontSize: "var(--text-sm)", color: "var(--fg-1)" }}>
            {who}
          </span>
        )}
        {report && <span data-batch-hold-report>{BATCH_HOLD_WORDS.latestReport(report)}</span>}
        <span data-batch-hold-summary>{summary}</span>
      </div>
      <div
        style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}
      >
        {leads && tryAgain(true)}
        {row && key && state !== "setting" && state !== "rule" && state !== "none" && (
          <Button
            variant={state === "approve" || state === "card" ? "primary" : "secondary"}
            size="sm"
            data-batch-hold-task={row.id}
            onClick={() => {
              const shell = useShellStore.getState();
              if (shell.view !== "home") shell.setView("home");
              void openTask({ taskId: row.id }).catch(() => {});
            }}
          >
            {BATCH_HOLD_WORDS.openTask(key)}
          </Button>
        )}
        {url && batch.number !== undefined && (
          <Button
            variant={state === "rule" ? "primary" : "secondary"}
            size="sm"
            onClick={() => void window.infinitary.app.openExternal(url).catch(() => {})}
          >
            {BATCH_HOLD_WORDS.open(changeNumberLabel(repo.host?.kind, batch.number))}
          </Button>
        )}
      </div>
      {leads ? (
        answers
      ) : (
        <details data-batch-hold-answers style={foldStyle}>
          <summary style={{ cursor: "pointer", color: "var(--fg-2)", fontSize: "var(--text-sm)" }}>
            {BATCH_HOLD_WORDS.answerYourself}
          </summary>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
              paddingTop: "var(--space-2)",
            }}
          >
            <span>
              {state === "rule" ? BATCH_HOLD_WORDS.answerRuleNote : BATCH_HOLD_WORDS.answerNote}
            </span>
            <div>{tryAgain(false)}</div>
            {answers}
          </div>
        </details>
      )}
      {done && <div role="status">{done}</div>}
      <SettingError error={error} surface="batch-hold" />
    </section>
  );
}

/** The fold Answer it yourself draws its by-hand answers in. */
const foldStyle: CSSProperties = {
  margin: 0,
  padding: "var(--space-2) var(--space-3)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-m)",
};

/**
 * A batch whose merge the host took and still reads as running, under
 * "Where changes go" (docs/forge.md, "Batches of your own"): since when,
 * its pull request, and Try again, which closes that pull request and
 * combines its changes on a new one. Nothing is sent again until then.
 */
export function BatchWaitPanel({
  repo,
  batch,
  wait,
}: {
  repo: Pick<RepoView, "id" | "host">;
  batch: OpenBatch;
  wait: { head: string; pending: number };
}) {
  const { busy, error, done, send } = useBatchAnswer(repo.id);
  const since = formatTime(wait.pending, { hour: "numeric", minute: "2-digit" });
  const place = repo.host ? forgePlace({ kind: repo.host.kind, host: repo.host.name }) : null;
  const url = batch.url;
  return (
    <section
      aria-label={BATCH_WAIT_WORDS.title}
      data-batch-wait={repo.id}
      style={panelStyle("var(--bg-2)")}
    >
      <div
        role="status"
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}
      >
        <span style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--fg-1)" }}>
          {BATCH_WAIT_WORDS.title}
        </span>
        <span data-batch-wait-summary>{BATCH_WAIT_WORDS.since(since, place)}</span>
      </div>
      <div
        style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}
      >
        {url && batch.number !== undefined && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void window.infinitary.app.openExternal(url).catch(() => {})}
          >
            {BATCH_HOLD_WORDS.open(changeNumberLabel(repo.host?.kind, batch.number))}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={busy !== null}
          pending={busy === "try-again"}
          onClick={() =>
            void send({ action: "try-again", head: wait.head }, BATCH_HOLD_WORDS.retried)
          }
        >
          {BATCH_HOLD_WORDS.tryAgain}
        </Button>
      </div>
      {done && <div role="status">{done}</div>}
      <SettingError error={error} surface="batch-wait" />
    </section>
  );
}

/** One answer to a project's open batch at a time, with its words once done or its refusal. */
function useBatchAnswer(repoId: string) {
  const [busy, setBusy] = useState<BatchAnswer["action"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const send = async (made: BatchAnswer, words: string): Promise<boolean> => {
    setBusy(made.action);
    setError(null);
    setDone(null);
    try {
      await window.infinitary.repos.batchAnswer(repoId, made);
      setDone(words);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, setError, done, send };
}

/** The box a batch's panel under "Where changes go" draws, on its state's background. */
function panelStyle(background: string): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
    marginBottom: "var(--space-3)",
    padding: "var(--space-3)",
    border: "1px solid var(--line-1)",
    borderRadius: "var(--radius-m)",
    background,
    fontSize: "var(--text-xs)",
    color: "var(--fg-2)",
  };
}
