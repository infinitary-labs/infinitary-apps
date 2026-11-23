import { FEEDBACK_LINK_MAX, type FeedbackKind, feedbackMark } from "@shared/feedback";

/**
 * The diagnostics a feedback report carries (docs/feedback.md, "What a
 * report holds"): a closed set of typed facts the host reads, never free
 * text, so no name, path, project or words can ride them.
 */
export type FeedbackDiagnostics = {
  app: { version: string; channel: string; install: string; language: string };
  system: { name: string; release: string; chip: string };
  /** Each other computer by system and app version; phones by app version. */
  computers: Array<{ system: string; version: string }>;
  phones: Array<{ version: string }>;
  /** Model connections by provider kind, project hosts by kind. */
  models: string[];
  projectHosts: string[];
  task?: FeedbackTaskFacts;
};

/** A task the report is about, as typed facts: its kinds and states, and its steps' kinds by minute. */
export type FeedbackTaskFacts = {
  kind: string;
  status: string;
  closed?: string;
  care?: string;
  delivery?: string;
  /** The pull request's check summary, and each check's state, never its name. */
  ci?: string;
  checks?: string[];
  steps: Array<{ minute: number; kind: string }>;
};

const WORD = /^[A-Za-z0-9 ._+/-]{1,40}$/;

/** A fact as the report prints it: a code word or version, never text that names anyone. */
function fact(value: string | undefined): string {
  return value && WORD.test(value) ? value : "unknown";
}

function counted(values: readonly string[]): string {
  if (values.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const value of values) counts.set(fact(value), (counts.get(fact(value)) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, count]) => (count > 1 ? `${value} ×${count}` : value))
    .join(", ");
}

/** The facts as Markdown lines, for the command's own answer and the issue's block. */
export function diagnosticsLines(
  facts: FeedbackDiagnostics,
  stepsMax = Number.POSITIVE_INFINITY,
): string[] {
  // i18n-exempt: the diagnostics block goes in a public issue for Infinitary's makers, in English
  const lines = [
    `- App: Infinitary ${fact(facts.app.version)} · ${fact(facts.app.channel)} · ${fact(facts.app.install)} · ${fact(facts.app.language)}`,
    `- System: ${fact(facts.system.name)} ${fact(facts.system.release)} · ${fact(facts.system.chip)}`,
    `- Other computers: ${counted(facts.computers.map((computer) => `${computer.system} ${computer.version}`))}`,
    `- Phones: ${counted(facts.phones.map((phone) => phone.version))}`,
    `- Model connections: ${counted([...new Set(facts.models)])}`,
    `- Project hosts: ${counted(facts.projectHosts)}`,
  ];
  const task = facts.task;
  if (task) {
    const states = [task.kind, task.status, task.closed, task.care, task.delivery]
      .filter((value): value is string => Boolean(value))
      .map(fact)
      .join(" · ");
    // i18n-exempt: the diagnostics block goes in a public issue for Infinitary's makers, in English
    lines.push(`- Task: ${states}`);
    if (task.ci || task.checks?.length) {
      const checks = [
        ...(task.ci ? [fact(task.ci)] : []),
        ...(task.checks?.length ? [counted(task.checks)] : []),
      ].join(" · ");
      // i18n-exempt: the diagnostics block goes in a public issue for Infinitary's makers, in English
      lines.push(`- Checks: ${checks}`);
    }
    const steps =
      stepsMax >= task.steps.length
        ? task.steps
        : task.steps.slice(task.steps.length - Math.max(0, stepsMax));
    if (steps.length > 0)
      // i18n-exempt: the diagnostics block goes in a public issue for Infinitary's makers, in English
      lines.push(
        `- Steps (minute: kind): ${steps.map((step) => `${Math.max(0, Math.round(step.minute))}: ${fact(step.kind)}`).join(", ")}`,
      );
  }
  return lines;
}

/** The block the draft adds at the end of an issue or comment, with the hidden mark. */
export function diagnosticsBlock(
  facts: FeedbackDiagnostics,
  kind: FeedbackKind,
  stepsMax = Number.POSITIVE_INFINITY,
): string {
  return [
    "<details><summary>Diagnostics from the app</summary>",
    "",
    ...diagnosticsLines(facts, stepsMax),
    "",
    "</details>",
    "",
    feedbackMark(kind, facts.app.version),
  ].join("\n");
}

/** The issue's whole body: the crewmate's words, then the diagnostics block. */
export function feedbackBody(
  words: string,
  facts: FeedbackDiagnostics,
  kind: FeedbackKind,
  stepsMax = Number.POSITIVE_INFINITY,
): string {
  return `${words.trim()}\n\n${diagnosticsBlock(facts, kind, stepsMax)}`;
}

/**
 * The largest count of a task's latest steps for which `size` of the body
 * stays within `max`, or undefined when even none fit. More steps only ever
 * make the body longer, so a binary search finds it.
 */
function stepsThatFit(
  words: string,
  facts: FeedbackDiagnostics,
  kind: FeedbackKind,
  max: number,
  size: (body: string) => number,
): number | undefined {
  const fits = (keep: number) => size(feedbackBody(words, facts, kind, keep)) <= max;
  if (!fits(0)) return undefined;
  let low = 0;
  let high = facts.task?.steps.length ?? 0;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The issue's body within GitHub's limit for one, `max` characters: the
 * task's earliest steps go first; undefined when the words alone do not fit.
 */
export function fittedBody(
  words: string,
  facts: FeedbackDiagnostics,
  kind: FeedbackKind,
  max: number,
): string | undefined {
  const keep = stepsThatFit(words, facts, kind, max, (body) => body.length);
  return keep === undefined ? undefined : feedbackBody(words, facts, kind, keep);
}

/**
 * The filled-in new-issue link for a person with no GitHub sign-in, at most
 * `FEEDBACK_LINK_MAX` characters: the task's earliest steps go first, then
 * the crewmate's words are cut with a note saying so.
 */
export function newIssueLink(
  repository: string,
  title: string,
  words: string,
  facts: FeedbackDiagnostics,
  kind: FeedbackKind,
): string {
  const link = (body: string) =>
    `https://github.com/${repository}/issues/new?${new URLSearchParams({ title, body }).toString()}`;
  const keep = stepsThatFit(words, facts, kind, FEEDBACK_LINK_MAX, (body) => link(body).length);
  if (keep !== undefined) return link(feedbackBody(words, facts, kind, keep));
  // i18n-exempt: the diagnostics block goes in a public issue for Infinitary's makers, in English
  const cut = "\n\n(The rest was too long for a link; add it on this page.)";
  let low = 0;
  let high = words.length;
  let best = link(feedbackBody(cut.trim(), facts, kind, 0));
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = link(feedbackBody(`${words.slice(0, middle)}${cut}`, facts, kind, 0));
    if (candidate.length <= FEEDBACK_LINK_MAX) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}
