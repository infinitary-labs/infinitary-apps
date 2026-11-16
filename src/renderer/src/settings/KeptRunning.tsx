import { formatDateTime } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import type { KeptJobsView, KeptJobView } from "@shared/keptJobs";
import { useEffect, useRef, useState } from "react";
import { useShellStore } from "../app/store";
import { KeyedText } from "../cards/TaskKey";
import { Button, StatusDot, type StatusDotTone } from "../design";
import { focusWithRing } from "../design/focus";
import { appReadExecutor } from "../plugins/reads/appExecutor";
import { LABEL_GAP, SettingError } from "./settingRows";

/**
 * Kept running, under Settings → Automation's rules (docs/leftover-programs.md,
 * "Kept running"; INF-4381's approved plan, piece 2): each job the captain
 * asked a crewmate to keep running past its task's close, by its label,
 * the computer it runs on, the account it runs as and the task that set it
 * up. Check runs the job's own check there; Remove asks once - its button
 * turns into Remove for good, which takes the keyboard - then runs the
 * job's remove there, through the catalog's `kept-job-remove`. A remove
 * that did not finish keeps the job listed with how it went, with Forget
 * beside it, which takes the job off the list without running anything and
 * says the job may still run on that computer. The section
 * shows only while a job is kept.
 */

/** A Settings item the Automation panel opens a kept job's row with (`point.openSettings`). */
export const KEPT_ITEM_PREFIX = "kept:";

const WHEN: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

const CHECK_TONES: Record<NonNullable<KeptJobView["checked"]>["outcome"], StatusDotTone> = {
  running: "ok",
  "not-running": "warn",
  "timed-out": "idle",
  unreachable: "idle",
};

/** What the job's last check says, in the row's words. */
export function keptCheckWords(job: KeptJobView): string | null {
  if (!job.checked) return null;
  const time = formatDateTime(job.checked.at, WHEN);
  switch (job.checked.outcome) {
    case "running":
      return m.settingsAutomationKeptRunning({ time });
    case "not-running":
      return m.settingsAutomationKeptNotRunning({ time });
    case "timed-out":
      return m.settingsAutomationKeptCheckUnfinished({ time });
    case "unreachable":
      return m.settingsAutomationKeptOutOfReach({ computer: job.computerName, time });
  }
}

/** What a remove that did not finish says, in the row's words. */
export function keptRemoveWords(job: KeptJobView): string | null {
  if (!job.removeFailed) return null;
  const time = formatDateTime(job.removeFailed.at, WHEN);
  return job.removeFailed.outcome === "unreachable"
    ? m.settingsAutomationKeptOutOfReach({ computer: job.computerName, time })
    : m.settingsAutomationKeptRemoveUnfinished({ time });
}

export function KeptRunning() {
  const [jobs, setJobs] = useState<KeptJobView[] | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const arrival = useShellStore((s) =>
    s.settingsItem?.section === "automation" && s.settingsItem.item.startsWith(KEPT_ITEM_PREFIX)
      ? s.settingsItem.item.slice(KEPT_ITEM_PREFIX.length)
      : null,
  );

  useEffect(
    () =>
      appReadExecutor().subscribe(
        "automation.kept",
        {},
        {
          onValue: (value) => {
            setUnreadable(false);
            setJobs((value as KeptJobsView).jobs);
          },
          // Unreadable is not empty: the jobs as last read stay.
          onError: () => setUnreadable(true),
        },
      ),
    [],
  );

  // A job a panel row opened: the keyboard lands on its Check.
  useEffect(() => {
    if (arrival === null || jobs === null) return;
    useShellStore.getState().clearSettingsItem();
    const button = listRef.current?.querySelector<HTMLElement>(
      `[data-kept-job="${CSS.escape(arrival)}"] [data-kept-check]`,
    );
    if (button) focusWithRing(button);
  }, [arrival, jobs]);

  // Remove asks once: Remove for good takes the keyboard.
  useEffect(() => {
    if (confirming === null) return;
    const button = listRef.current?.querySelector<HTMLElement>(
      `[data-kept-job="${CSS.escape(confirming)}"] [data-kept-remove-for-good]`,
    );
    if (button) focusWithRing(button);
  }, [confirming]);

  const replace = (job: KeptJobView) =>
    setJobs((list) => (list ?? []).map((entry) => (entry.id === job.id ? job : entry)));
  const run = async (id: string, work: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };
  const check = (job: KeptJobView) =>
    run(job.id, async () => replace(await window.infinitary.automation.checkKept(job.id)));
  const remove = (job: KeptJobView) =>
    run(job.id, async () => {
      setConfirming(null);
      const result = await window.infinitary.automation.removeKept(job.id);
      if (result.removed) setJobs((list) => (list ?? []).filter((entry) => entry.id !== job.id));
      else if (result.job) replace(result.job);
    });
  const forget = (job: KeptJobView) =>
    run(job.id, async () => {
      await window.infinitary.automation.forgetKept(job.id);
      setJobs((list) => (list ?? []).filter((entry) => entry.id !== job.id));
    });

  // Shown only while a job is kept; an unreadable list with none known shows nothing.
  if (!jobs || jobs.length === 0) return null;
  return (
    <section
      data-kept-running=""
      aria-labelledby="kept-running-title"
      style={{ display: "flex", flexDirection: "column", gap: LABEL_GAP }}
    >
      <div>
        <div
          id="kept-running-title"
          style={{ fontSize: "var(--text-md)", color: "var(--fg-1)", fontWeight: 500 }}
        >
          {m.settingsAutomationKeptTitle()}
        </div>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
          {m.settingsAutomationKeptDescription()}
        </div>
      </div>
      <SettingError error={error} />
      {unreadable && <SettingError error={m.settingsAutomationKeptUnreadable()} />}
      <ul
        ref={listRef}
        aria-label={m.settingsAutomationKeptList()}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
          listStyle: "none",
          margin: 0,
          padding: 0,
        }}
      >
        {jobs.map((job) => {
          const checked = keptCheckWords(job);
          const removeFailed = keptRemoveWords(job);
          const asking = confirming === job.id;
          return (
            <li
              key={job.id}
              data-kept-job={job.id}
              style={{
                display: "grid",
                gridTemplateColumns: "auto minmax(0, 1fr) auto",
                columnGap: "var(--space-3)",
                alignItems: "center",
                padding: "var(--space-2) var(--space-3)",
                border: "1px solid var(--line-1)",
                borderRadius: "var(--radius-m)",
              }}
            >
              <StatusDot
                tone={job.checked ? CHECK_TONES[job.checked.outcome] : "ring"}
                label={checked ?? m.settingsAutomationKeptTitle()}
                nativeTitle={false}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ color: "var(--fg-1)", fontSize: "var(--text-base)" }}>
                  {job.label}
                </span>
                <span style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>
                  <KeyedText
                    text={m.settingsAutomationKeptFrom({
                      computer: job.computerName,
                      account: job.account,
                      key: job.key || job.task,
                    })}
                  />
                </span>
                {checked && (
                  <span
                    data-kept-checked={job.checked?.outcome}
                    style={{ color: "var(--fg-2)", fontSize: "var(--text-sm)" }}
                  >
                    {checked}
                  </span>
                )}
                {removeFailed && (
                  <span
                    data-kept-remove-failed={job.removeFailed?.outcome}
                    style={{ color: "var(--warn)", fontSize: "var(--text-sm)" }}
                  >
                    {removeFailed}
                  </span>
                )}
                {asking && (
                  <span style={{ color: "var(--fg-2)", fontSize: "var(--text-sm)" }}>
                    {m.settingsAutomationKeptRemoveAsk({ computer: job.computerName })}
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void check(job)}
                  data-kept-check=""
                >
                  {m.settingsAutomationKeptCheck()}
                </Button>
                {asking ? (
                  <Button
                    type="button"
                    variant="danger"
                    disabled={busy !== null}
                    onClick={() => void remove(job)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        setConfirming(null);
                      }
                    }}
                    onBlur={() => setConfirming((id) => (id === job.id ? null : id))}
                    data-kept-remove-for-good=""
                  >
                    {m.settingsAutomationKeptRemoveForGood()}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => setConfirming(job.id)}
                    data-kept-remove=""
                  >
                    {m.settingsAutomationKeptRemove()}
                  </Button>
                )}
              </div>
              {job.removeFailed && !asking && (
                // Its own line under the row, so its long label never squeezes the
                // job's words; the ghost button's padding hangs toward the start so its words
                // line up with the job's.
                <div
                  style={{
                    gridColumn: "2 / -1",
                    marginTop: "var(--space-1)",
                    marginInlineStart: -12,
                  }}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void forget(job)}
                    data-kept-forget=""
                  >
                    {m.settingsAutomationKeptForget({ computer: job.computerName })}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
