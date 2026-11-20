/** Local facts the teacher writes; teaching judgments stay in progress.md. */
export type LessonRecord = {
  subject: string;
  title: string;
  taskKey: string;
  goal: string;
  sittings: string[];
  paused: { from: string; to: string }[];
  skills: { name: string; state: "learned" | "practising" | "next"; since?: string }[];
  next: { title: string; minutes: number };
};

const DAY = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY;
const dateOf = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
const isDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(dayNumber(value)) && dateOf(dayNumber(value)) === value;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected lesson record");
  return value as Record<string, unknown>;
};
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Invalid input never masquerades as zero progress. */
export function readRecord(value: unknown): LessonRecord {
  const r = object(value);
  if (!text(r.subject) || !text(r.title) || !text(r.taskKey) || !text(r.goal) ||
    !Array.isArray(r.sittings) || !r.sittings.every(isDate) ||
    !Array.isArray(r.paused) || !r.paused.every((p) => {
      const span = object(p);
      return isDate(span.from) && isDate(span.to) && span.from <= span.to;
    }) ||
    !Array.isArray(r.skills) || !r.skills.every((skill) => {
      const s = object(skill);
      return text(s.name) && ["learned", "practising", "next"].includes(String(s.state)) &&
        (s.state === "next" ? s.since === undefined || isDate(s.since) : isDate(s.since));
    })) throw new Error("Invalid lesson record");
  const next = object(r.next);
  if (!text(next.title) || typeof next.minutes !== "number" || !Number.isFinite(next.minutes) || next.minutes <= 0)
    throw new Error("Invalid next lesson");
  return r as LessonRecord;
}

/** The computer's local calendar date, not a UTC day or a rolling 24-hour window. */
export function localDay(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Replay calendar facts in order. Five unique practice days earn one rest,
 * capped AT THE TIME it is earned, not an unlimited lifetime reserve.
 * A rest or requested pause bridges days but never counts as practice.
 * Today is not missed until tomorrow. Derived only; no record or store writes.
 */
export function practiceOf(record: LessonRecord, today: string) {
  const end = dayNumber(today);
  const dates = [...new Set(record.sittings)].filter((d) => d <= today).sort();
  const practice = new Set(dates);
  const pauses = record.paused.map((p) => ({ from: dayNumber(p.from), to: dayNumber(p.to) }));
  const paused = (d: number) => pauses.some((p) => p.from <= d && d <= p.to);
  let run = 0, best = 0, bank = 0, earned = 0;
  const rest: string[] = [];
  // No work proportional to an arbitrary future date: only elapsed learner history.
  const start = dates.length ? dayNumber(dates[0] as string) : end;
  for (let d = start; d <= end; d++) {
    const date = dateOf(d);
    if (practice.has(date)) {
      run++;
      best = Math.max(best, run);
      earned++;
      if (earned % 5 === 0) bank = Math.min(2, bank + 1);
    } else if (!paused(d) && d < end) {
      if (bank > 0) { bank--; rest.push(date); } else run = 0;
    }
  }
  const pause = pauses.find((p) => p.from <= end && end <= p.to);
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = end - 13 + i, date = dateOf(d);
    return { date, state: practice.has(date) ? "practised" : paused(d) ? "paused" : rest.includes(date) ? "rest" : d === end ? "today" : "empty" };
  });
  return { today, run, best, bank, days, last: dates.at(-1) ?? null,
    todayDone: practice.has(today), pauseUntil: pause ? dateOf(pause.to) : null,
    restedYesterday: rest.includes(dateOf(end - 1)) };
}
export type Practice = ReturnType<typeof practiceOf>;
export type LessonSnapshot = { record: LessonRecord; practice: Practice } | { error: string } | null;
