import type { PanelBatchRepo, PanelBatchTask, PanelProps, PanelTaskRow } from "@infinitary/contracts";
import { Disclosure, focusWithRing, Row, StatusDot, useMinute } from "@infinitary/ui";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import * as m from "./messages.generated";
import styles from "./panel.css";
import {
  answersInSettings,
  batchTitle,
  clock,
  crewHolds,
  type HoldState,
  holdOf,
  holdSentence,
  namesRepair,
  showsAny,
  stateOf,
  stateShort,
  taskName,
  toneOf,
  took,
  waitShort,
} from "./words";

/**
 * The Batches panel (docs/forge.md, "The Batches panel"): the panel the
 * Batched pull requests runbook shows while it is on, under Tasks on the
 * right rail. It reads `batches.list` - the app's own record of each
 * batched project's line, open batch, changes left out and the batches that
 * ended in the last day - and puts itself on the rail only while one of
 * those holds anything in the project the window is focused on.
 *
 * A held batch says who has its next step (docs/forge.md, "A held batch"):
 * its repair, named by key with its latest report line, a rule, the captain,
 * or no one. Open in Settings shows only while Settings holds the captain's
 * next step: a setting, a rule or no repair.
 *
 * It only points: a member's chip, the repair's key or a left-out row opens
 * its task as a Tasks row does, and resting on a chip peeks; the open batch,
 * the waiting row and a Last day row put up the details card; Open in
 * Settings opens the held batch in Settings → Projects. Nothing here merges,
 * tries again or sends back. Its rows and chips are one Tab stop with the arrows inside,
 * the Last day toggle a second, Enter acts, and F6 brings focus here (`asks.onFocus`).
 */

/** A roving stop's props on a button. */
type Stop = {
  "data-batches-stop": string;
  tabIndex: number;
  onFocus: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
};

/** The chips an open batch shows before "+N more" puts up the card. */
const CHIPS_SHOWN = 6;

export default function BatchesPanel({ reads, rail, asks, point, cards, view }: PanelProps) {
  const [repos, setRepos] = useState<PanelBatchRepo[] | null>(null);
  const [stop, setStop] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const now = useMinute();

  const [rows, setRows] = useState<PanelTaskRow[] | null>(null);

  useEffect(() => reads.subscribe("batches.list", (value) => setRepos(value.repos)), [reads]);
  // The board says whether a held batch's repair waits on a card of the captain's.
  useEffect(
    () => reads.subscribe("tasks.board", { closed: false }, (value) => setRows(value.tasks)),
    [reads],
  );

  const focused = view.focusedProjectId;
  const shown = (repos ?? []).filter(
    (repo) => showsAny(repo) && (focused === null || repo.projectId === focused),
  );

  // On its rail while a batch runs, a change waits or is left out, or a batch
  // ended in the last day, in the project the window is focused on.
  useEffect(() => {
    if (!rail || repos === null) return;
    if (shown.length === 0) {
      rail.show(false, m.batchesPanelEmpty());
      rail.summarize(null);
      return;
    }
    rail.show(true);
    const open = shown.flatMap((repo) => (repo.open ? [repo.open] : []));
    const held = open.find((batch) => batch.hold);
    const lead = held ?? open[0];
    const leadHold = lead ? holdOf(lead, rows) : null;
    const waiting = shown.reduce((sum, repo) => sum + repo.line.length, 0);
    const leftOut = shown.reduce((sum, repo) => sum + repo.leftOut.length, 0);
    rail.summarize([
      // Bright while the next step is not the crew's, as every panel marks what needs you.
      ...(lead
        ? [
            {
              text: stateShort(lead, now, leadHold),
              ...(leadHold && !crewHolds(leadHold) ? { strong: true } : {}),
            },
          ]
        : []),
      ...(waiting > 0 ? [{ text: m.batchesPanelWaitingCount({ count: waiting }) }] : []),
      ...(leftOut > 0 ? [{ text: m.batchesPanelLeftOutCount({ count: leftOut }) }] : []),
    ]);
  });

  // F6 lands on the panel's stop.
  useEffect(
    () =>
      asks.onFocus(() => {
        const row = rootRef.current?.querySelector<HTMLElement>('button[tabindex="0"]');
        if (row) focusWithRing(row);
      }),
    [asks],
  );

  const details = () =>
    void cards
      .emit({ id: "details", view: "details", title: m.batchesPanelTitle(), width: "wide" })
      .catch(() => "");
  const openTask = (taskId: string) => void point.openTask(taskId).catch(() => false);
  const peek = (taskId: string | null, target?: HTMLElement) => {
    if (!taskId || !target) {
      point.peekTask(null);
      return;
    }
    const { top, right, bottom, left } = target.getBoundingClientRect();
    point.peekTask({ taskId, box: { top, right, bottom, left } });
  };

  // One roving stop over every row and chip, in the order they are drawn.
  const [lastDayOpen, setLastDayOpen] = useState(false);
  const stops: string[] = [];
  for (const repo of shown) {
    const id = repo.repoId;
    if (repo.open) {
      stops.push(`open:${id}`);
      const hold = holdOf(repo.open, rows);
      if (hold && repo.open.repair && namesRepair(hold)) stops.push(`repair:${id}`);
      if (answersInSettings(hold)) stops.push(`answer:${id}`);
      for (const member of repo.open.members.slice(0, CHIPS_SHOWN))
        stops.push(`chip:${id}:${member.taskId}`);
      if (repo.open.members.length > CHIPS_SHOWN) stops.push(`more:${id}`);
    }
    if (repo.line.length > 0) stops.push(`line:${id}`);
    for (const entry of repo.leftOut) stops.push(`left:${id}:${entry.taskId}`);
    if (lastDayOpen) for (const batch of repo.finished) stops.push(`done:${id}:${batch.number}`);
  }
  const current = stops.includes(stop ?? "") ? stop : (stops[0] ?? null);
  const stopProps = (id: string) => ({
    "data-batches-stop": id,
    tabIndex: id === current ? 0 : -1,
    onFocus: () => setStop(id),
    onKeyDown: onKey,
  });
  function onKey(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const at = stops.indexOf(current ?? "");
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? Math.min(stops.length - 1, at + 1)
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? Math.max(0, at - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? stops.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const id = stops[next];
    if (!id) return;
    setStop(id);
    const target = rootRef.current?.querySelector<HTMLElement>(
      `[data-batches-stop="${CSS.escape(id)}"]`,
    );
    const button = target?.matches("button") ? target : target?.querySelector("button");
    if (button) focusWithRing(button);
  }
  // A Row draws its own button: its stop rides the list item around it.
  const rowStop = (id: string) => {
    const { onKeyDown, onFocus, tabIndex } = stopProps(id);
    return { tabIndex, onKeyDown, onFocus };
  };

  const several = shown.length > 1;
  const finished = shown.reduce((sum, repo) => sum + repo.finished.length, 0);

  return (
    <div ref={rootRef} className="fm-batches-panel" data-batches-panel="">
      <style>{styles}</style>
      {shown.map((repo) => (
        <section
          key={repo.repoId}
          className="fm-batches-panel-repo"
          data-batches-repo={repo.repoId}
          aria-label={repo.name}
        >
          {several && <h3 className="fm-batches-panel-heading">{repo.name}</h3>}
          {repo.open && (() => {
            const open = repo.open;
            const hold = holdOf(open, rows);
            const short = stateShort(open, now, hold);
            const title = batchTitle(open.number, open.members.length);
            return (
            <div className="fm-batches-panel-open" data-batches-open={open.number ?? ""}>
              <div data-batches-stop={`open:${repo.repoId}`}>
                <Row
                  title={title}
                  tone={toneOf(open, hold)}
                  toneLabel={short}
                  // A held row's line below says who has it, so the row keeps only how long, and its title room.
                  trailing={hold ? took(now - (open.hold?.at ?? now)) : short}
                  ariaLabel={`${title} · ${short}`}
                  onClick={details}
                  {...rowStop(`open:${repo.repoId}`)}
                />
              </div>
              {hold && (
                <HoldLine
                  open={open}
                  hold={hold}
                  report={rows?.find((task) => task.id === open.repair?.taskId)?.outcomeSummary ?? null}
                  stop={stops.includes(`repair:${repo.repoId}`) ? stopProps(`repair:${repo.repoId}`) : null}
                  onOpen={openTask}
                />
              )}
              <OpenDetail open={open} hold={hold} />
              {answersInSettings(hold) && (
                <button
                  type="button"
                  className="fm-batches-panel-answer"
                  {...stopProps(`answer:${repo.repoId}`)}
                  onClick={() =>
                    void point.openSettings("projects", `batch:${repo.repoId}`).catch(() => false)
                  }
                >
                  {m.batchesPanelOpenSettings()}
                </button>
              )}
              <ul className="fm-batches-panel-chips" aria-label={m.batchesPanelMembersLabel()}>
                {open.members.slice(0, CHIPS_SHOWN).map((member) => (
                  <li key={member.taskId}>
                    <Chip
                      task={member}
                      {...stopProps(`chip:${repo.repoId}:${member.taskId}`)}
                      onOpen={openTask}
                      onPeek={peek}
                    />
                  </li>
                ))}
                {open.members.length > CHIPS_SHOWN && (
                  <li>
                    <button
                      type="button"
                      className="fm-batches-panel-chip"
                      {...stopProps(`more:${repo.repoId}`)}
                      onClick={details}
                    >
                      {m.batchesPanelMore({ count: open.members.length - CHIPS_SHOWN })}
                    </button>
                  </li>
                )}
              </ul>
            </div>
            );
          })()}
          <ul className="fm-batches-panel-list" aria-label={m.batchesPanelListLabel()}>
            {repo.line.length > 0 && (
              <li data-batches-line="" data-batches-stop={`line:${repo.repoId}`}>
                <Row
                  title={m.batchesPanelWaiting({ count: repo.line.length })}
                  tone="ring"
                  toneLabel={m.batchesPanelWaitingHeading()}
                  trailing={waitShort(repo)}
                  onClick={details}
                  {...rowStop(`line:${repo.repoId}`)}
                />
              </li>
            )}
            {repo.leftOut.map((entry) => (
              <li
                key={entry.taskId}
                data-batches-left-out={entry.taskId}
                data-batches-stop={`left:${repo.repoId}:${entry.taskId}`}
                title={entry.reason}
                onPointerEnter={(event) => peek(entry.taskId, event.currentTarget)}
                onPointerLeave={() => peek(null)}
              >
                <Row
                  title={taskName(entry)}
                  tone="warn"
                  toneLabel={m.batchesPanelLeftOut()}
                  word={m.batchesPanelLeftOut()}
                  trailing={<span className="fm-batches-panel-reason">{entry.reason}</span>}
                  ariaLabel={`${taskName(entry)} · ${m.batchesPanelLeftOut()} · ${entry.reason}`}
                  onClick={() => openTask(entry.taskId)}
                  {...rowStop(`left:${repo.repoId}:${entry.taskId}`)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {finished > 0 && (
        <Disclosure
          label={m.batchesPanelLastDay()}
          count={finished}
          open={lastDayOpen}
          onToggle={setLastDayOpen}
        >
          <ul className="fm-batches-panel-list" data-batches-last-day="">
            {shown.flatMap((repo) =>
              repo.finished.map((batch) => (
                <li
                  key={`${repo.repoId}:${batch.number}`}
                  data-batches-finished={batch.number}
                  data-batches-stop={`done:${repo.repoId}:${batch.number}`}
                >
                  <Row
                    title={batchTitle(batch.number, batch.members.length)}
                    tone={batch.outcome === "merged" ? "ok" : "idle"}
                    toneLabel={batch.outcome === "merged" ? m.batchesPanelMerged() : m.batchesPanelClosed()}
                    trailing={
                      batch.outcome === "merged"
                        ? m.batchesPanelEndedTook({
                            time: clock(batch.ended),
                            took: took(batch.ended - batch.formed),
                          })
                        : m.batchesPanelClosed()
                    }
                    onClick={details}
                    {...rowStop(`done:${repo.repoId}:${batch.number}`)}
                  />
                </li>
              )),
            )}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}

/**
 * Under a held batch's row: who has the hold, its repair's key a button that
 * opens its task, and the repair's latest report line beneath. The key's
 * button is a stop of the panel's roving set while the sentence names it.
 */
function HoldLine({
  open,
  hold,
  report,
  stop,
  onOpen,
}: {
  open: NonNullable<PanelBatchRepo["open"]>;
  hold: HoldState;
  report: string | null;
  stop: Stop | null;
  onOpen: (taskId: string) => void;
}) {
  const sentence = holdSentence(open, hold);
  const repair = open.repair;
  const key = repair ? taskName(repair) : "";
  const at = stop && namesRepair(hold) ? sentence.indexOf(key) : -1;
  const shows = report && crewHolds(hold) && hold !== "passed";
  return (
    <>
      <p
        className={`fm-batches-panel-who${crewHolds(hold) ? "" : " fm-batches-panel-who-lit"}`}
        data-batches-who={hold}
      >
        {at >= 0 && repair && stop ? (
          <>
            {sentence.slice(0, at)}
            <button
              type="button"
              className="fm-batches-panel-chip"
              data-batches-repair={repair.taskId}
              title={repair.title}
              aria-label={m.batchesPanelOpenTask({ key })}
              {...stop}
              onClick={() => onOpen(repair.taskId)}
            >
              {key}
            </button>
            {sentence.slice(at + key.length)}
          </>
        ) : (
          sentence
        )}
      </p>
      {shows && (
        <p className="fm-batches-panel-report" data-batches-report="">
          {report}
        </p>
      )}
    </>
  );
}

/** A failed check's sentence around its name, which `{first}` puts anywhere in a language. */
const NAME = "\u0000";

/**
 * Under the open batch's row: its checks as last read, a hold's failed checks,
 * and a declared fix. A failed check's name takes one line and shows its end,
 * which names the job; resting on it shows the whole name. A fix the repair
 * declared is said by the hold's sentence, so its line is left out.
 */
function OpenDetail({ open, hold }: { open: NonNullable<PanelBatchRepo["open"]>; hold: HoldState | null }) {
  const checks = open.checks;
  const total = checks ? checks.passed + checks.failed + checks.running : 0;
  const state = stateOf(open);
  const count = open.hold?.checks.length ?? 0;
  const first = open.hold?.checks[0] ?? "";
  const failed = m.batchesPanelFailed({ count, first });
  const [before = "", after = ""] = m.batchesPanelFailed({ count, first: NAME }).split(NAME);
  const fixKeys = hold ? open.fixKeys.filter((key) => key !== open.repair?.key) : open.fixKeys;
  return (
    <div className="fm-batches-panel-detail" data-batches-checks="">
      {checks && total > 0 ? (
        <>
          <span
            className="fm-batches-panel-bar"
            role="img"
            aria-label={m.batchesPanelChecksPassed({ passed: String(checks.passed), total: String(total) })}
          >
            <span style={{ inlineSize: `${(checks.passed / total) * 100}%` }} />
            {checks.failed > 0 && (
              <span
                className="fm-batches-panel-bar-failed"
                style={{ inlineSize: `${(checks.failed / total) * 100}%` }}
              />
            )}
          </span>
          <span>{m.batchesPanelChecksPassed({ passed: String(checks.passed), total: String(total) })}</span>
        </>
      ) : (
        state === "checking" && <span>{m.batchesPanelChecksUnread()}</span>
      )}
      {open.hold?.reason === "checks" && open.hold.checks.length > 0 && (
        <span className="fm-batches-panel-failed" data-batches-failed="" title={failed}>
          <StatusDot tone="danger" label={failed} />
          {before && <span className="fm-batches-panel-nowrap">{before.trimEnd()}</span>}
          <span className="fm-batches-panel-cut">
            <bdi dir="ltr">{first}</bdi>
          </span>
          {after && <span className="fm-batches-panel-nowrap">{after.trimStart()}</span>}
        </span>
      )}
      {fixKeys.length > 0 && (
        <span data-batches-fix="">{m.batchesPanelFix({ keys: fixKeys.join(", ") })}</span>
      )}
    </div>
  );
}

/** A member's chip: its key, which opens its task, and peeks while the pointer rests on it. */
function Chip({
  task,
  onOpen,
  onPeek,
  ...stop
}: {
  task: PanelBatchTask;
  onOpen: (taskId: string) => void;
  onPeek: (taskId: string | null, target?: HTMLElement) => void;
} & Stop) {
  return (
    <button
      type="button"
      className="fm-batches-panel-chip"
      data-batches-member={task.taskId}
      title={task.title}
      aria-label={`${taskName(task)} · ${task.title}`}
      {...stop}
      onClick={() => onOpen(task.taskId)}
      onPointerEnter={(event) => onPeek(task.taskId, event.currentTarget)}
      onPointerLeave={() => onPeek(null)}
    >
      {taskName(task)}
    </button>
  );
}
