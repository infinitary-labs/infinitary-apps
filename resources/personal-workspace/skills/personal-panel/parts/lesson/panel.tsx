import type { PanelProps, PanelTaskBoard } from "@infinitary/contracts";
import { Empty, MicroLabel, Row, focusWithRing } from "@infinitary/ui";
import { useEffect, useRef, useState } from "react";
import type { LessonSnapshot } from "./record";
import styles from "./panel.css";

// The locale the frame's document names for dates; a bare call writes US forms in the packaged Mac app.
const dateLabel = (date: string) => new Intl.DateTimeFormat(document.documentElement.getAttribute("data-locale") ?? undefined, {
  month: "short", day: "numeric",
}).format(new Date(`${date}T12:00:00`));

export default function Panel({ store, reads, point, rail, asks }: PanelProps) {
  const root = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<LessonSnapshot>(null);
  const [board, setBoard] = useState<PanelTaskBoard | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => void store.get("lesson").then((value) => {
      if (live) setSnapshot((value ?? null) as LessonSnapshot);
    });
    read();
    const off = store.subscribe(read);
    return () => { live = false; off(); };
  }, [store]);
  useEffect(() => reads.subscribe("tasks.board", setBoard), [reads]);
  const lesson = snapshot && "record" in snapshot ? snapshot : null;
  const learned = lesson?.record.skills.filter((s) => s.state === "learned").length ?? 0;
  useEffect(() => {
    rail?.summarize(lesson ? [
      ...(lesson.practice.run ? [{ text: `day ${lesson.practice.run}` }] : []),
      ...(learned ? [{ text: `${learned} learned` }] : []),
    ] : null);
    return () => rail?.summarize(null);
  }, [rail, lesson, learned]);
  useEffect(() => asks?.onFocus(() => {
    const button = root.current?.querySelector<HTMLButtonElement>(".lesson-next");
    if (button) focusWithRing(button);
  }), [asks]);
  if (!snapshot) return null;
  if ("error" in snapshot) return <Empty>{snapshot.error}</Empty>;
  const { record, practice: p } = snapshot;
  const task = board?.tasks.find((row) => row.key === record.taskKey);
  const ready = task?.waitingCardId != null;
  const count = <span className="lesson-number">{p.run}</span>;
  return <div ref={root} className="lesson-panel">
    <style>{styles}</style>
    <section><MicroLabel>Goal</MicroLabel><p className="lesson-goal">{record.goal}</p></section>
    <section>
      <MicroLabel>Days practised</MicroLabel>
      <div className="lesson-days" role="img" aria-label={p.days.map((d) => `${dateLabel(d.date)}: ${d.state}`).join(", ")}>
        {p.days.map((d) => <i key={d.date} data-state={d.state} aria-hidden="true" />)}
      </div>
      <p>{p.pauseUntil ? <>Paused until {dateLabel(p.pauseUntil)} · {count} days practised</> :
        p.run ? <>{count} {p.run === 1 ? "day" : "days in a row"}, nice going!</> : <>Welcome back!</>}</p>
      <p className="lesson-muted">Best run: <span className="lesson-number">{p.best}</span> · Rest days banked: <span className="lesson-number">{p.bank}</span></p>
      {p.restedYesterday && <p className="lesson-muted">A rest day covered yesterday.</p>}
      {!p.run && p.last && <p className="lesson-muted">Last practised {dateLabel(p.last)}.</p>}
    </section>
    <section>
      <MicroLabel count={`${learned} of ${record.skills.length} learned`}>Skills</MicroLabel>
      <div className="lesson-bar" role="progressbar" aria-label="Skills learned" aria-valuemin={0} aria-valuemax={record.skills.length || 1} aria-valuenow={learned}>
        <i style={{ width: `${record.skills.length ? learned / record.skills.length * 100 : 0}%` }} />
      </div>
      {record.skills.length ? record.skills.map((s) => <Row key={s.name} title={s.name}
        tone={s.state === "learned" ? "ok" : s.state === "practising" ? "ring" : "idle"}
        toneLabel={s.state} trailing={s.state === "learned" && s.since ? dateLabel(s.since) : s.state}
        ariaLabel={`${s.name}: ${s.state}${s.since ? `, ${dateLabel(s.since)}` : ""}`} />) : <Empty>Your teacher will name the next skill.</Empty>}
    </section>
    {p.todayDone && <p className="lesson-muted">Done for today!</p>}
    {ready && point && task ? <button type="button" className="lesson-next"
      onClick={() => point.openTask(task.id)}>
      <span>{p.todayDone ? "Next: " : "Let's go: "}{record.next.title}</span>
      <span className="lesson-number">~{record.next.minutes} min</span>
    </button> : <p className="lesson-muted">Next: {record.next.title}. {task && (task.status === "open" || task.status === "active") ? "Your teacher is preparing your lesson." : "These lessons are stopped."}</p>}
  </div>;
}
