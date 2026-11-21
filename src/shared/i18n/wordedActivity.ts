import type { TaskActivityLine, TaskDetail } from "../tasks.ts";
import { wordedLine } from "./said.ts";

/**
 * A record's Activity with each line the app saved as a fact worded now, in
 * the process's language (docs/i18n.md, "Saved facts"), and the timeline
 * reading of each such line's event with it; a panel reads the words.
 */
export function wordedActivity(detail: TaskDetail): TaskDetail {
  // Each worded line's English, by its event, so the timeline reading the
  // record draws for that event shows the same words (`entry.summary`).
  const english = new Map<number, { from: string; to: string }>();
  const worded = <L extends TaskActivityLine>({ said, ...line }: L) => {
    if (!said) return line as L;
    const text = wordedLine({ text: line.text, said });
    english.set(line.id, { from: line.text, to: text });
    return { ...line, text } as L;
  };
  if (!detail.activityLog.some((row) => row.said || row.folded?.some((line) => line.said)))
    return detail;
  const activityLog = detail.activityLog.map((row) => ({
    ...worded(row),
    ...(row.folded ? { folded: row.folded.map(worded) } : {}),
  }));
  const said = (reading: NonNullable<TaskDetail["timeline"]>[number]) => {
    const { ref } = reading.entry.content;
    const ids = [
      ...(ref.source === "task-event" ? [`task-event:${ref.eventId}`] : []),
      ...reading.entry.aliases,
    ];
    for (const id of ids) {
      const line = /^task-event:\d+$/.test(id) && english.get(Number(id.slice(11)));
      if (line) return line;
    }
    return undefined;
  };
  const timeline = detail.timeline?.map((reading) => {
    const line = said(reading);
    if (!line) return reading;
    const swap = (text: string) => (text === line.from ? line.to : text);
    return {
      ...reading,
      entry: { ...reading.entry, summary: swap(reading.entry.summary) },
      text: reading.text === null ? null : swap(reading.text),
    };
  });
  return { ...detail, activityLog, ...(timeline ? { timeline } : {}) };
}
