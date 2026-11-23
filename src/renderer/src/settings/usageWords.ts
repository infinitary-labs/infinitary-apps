import { formatLanguageDate, formatLanguageDateTime, formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import {
  type UsageAmount,
  type UsageAttribution,
  type UsageCategory,
  type UsageDay,
  type UsageModel,
  type UsagePeriod,
  type UsagePriceSource,
  type UsageScope,
  type UsageSummary,
  type UsageTask,
  type UsageUnit,
  type UsageWhere,
  type UsageWorkKind,
  usageMilestone,
  usageTokens,
  usageValue,
} from "@shared/usage";

/**
 * Settings → Usage's words and numbers (docs/usage.md; the design skill's
 * `components/usage/UsageTab.prompt.md`). Pure, so every printed word and
 * computed number has one home and one focused test.
 */

export const USAGE_WORDS = {
  get notAvailable() {
    return m.settingsUsageNotAvailable();
  },
} as const;

export const PERIOD_WORDS: Readonly<Record<UsagePeriod, string>> = {
  get "7d"() {
    return m.settingsUsagePeriod7d();
  },
  get "30d"() {
    return m.settingsUsagePeriod30d();
  },
  get all() {
    return m.settingsUsagePeriodAll();
  },
};

export const SCOPE_WORDS: Readonly<Record<UsageScope, string>> = {
  get all() {
    return m.settingsUsageScopeAll();
  },
  get task() {
    return m.settingsUsageScopeTask();
  },
  get firstmate() {
    return m.settingsUsageScopeFirstmate();
  },
  get other() {
    return m.settingsUsageScopeOther();
  },
};

export const UNIT_WORDS: Readonly<Record<UsageUnit, string>> = {
  get tokens() {
    return m.settingsUsageUnitTokens();
  },
  get usd() {
    return m.settingsUsageUnitUsd();
  },
};

export function unitHeading(unit: UsageUnit): string {
  return unit === "tokens" ? m.settingsUsageHeadingTokens() : m.settingsUsageHeadingUsd();
}

export function compactTokens(tokens: number): string {
  if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(2)}B`;
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(2)}M`;
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}k`;
  return formatNumber(Math.round(tokens));
}

/** An estimate in US dollars: $17.18, $1,204, and under a cent never as $0.00. */
export function dollars(usd: number): string {
  if (usd >= 1000) return `$${formatNumber(Math.round(usd))}`;
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function formatUsage(value: number | null, unit: UsageUnit): string {
  if (value === null) return USAGE_WORDS.notAvailable;
  return unit === "tokens" ? compactTokens(value) : dollars(value);
}

export function formatAmount(amount: UsageAmount, unit: UsageUnit): string {
  return formatUsage(usageValue(amount, unit), unit);
}

/** An amount with nothing recorded says so; it is not a measured zero. */
export function formatRecorded(amount: UsageAmount, unit: UsageUnit): string {
  return amount.records === 0 ? m.settingsUsageNoActivity() : formatAmount(amount, unit);
}

export function formatDay(day: UsageDay, unit: UsageUnit): string {
  return formatRecorded(day.amount, unit);
}

/** "Oct 5": a local date as the chart and the table name it. */
export function shortDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return formatLanguageDate(new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1), {
    month: "short",
    day: "numeric",
  });
}

/** The period's dates: "Sep 6–Oct 5 · Local dates", or since the first record. */
export function periodLabel(summary: UsageSummary): string {
  const first = summary.days[0]?.date;
  const last = summary.days.at(-1)?.date;
  if (!first || !last) return m.settingsUsageNothingRecorded();
  if (summary.query.period === "all") return m.settingsUsagePeriodSince({ date: shortDate(first) });
  return m.settingsUsagePeriodRange({ first: shortDate(first), last: shortDate(last) });
}

/** Records priced, as the dollar view's coverage line says it. */
export function pricedLine(amount: UsageAmount): string {
  return m.settingsUsagePriced({ priced: String(amount.priced), records: String(amount.records) });
}

/** Whether every record reported every category; missing older coverage is unknown. */
export function completeTokens(amount: UsageAmount): boolean {
  return (
    amount.tokenReported !== undefined &&
    Object.values(amount.tokenReported).every((count) => count === amount.records)
  );
}

/** One model category's measured coverage, including zero records, or unknown coverage. */
export function tokenCategoryCoverage(amount: UsageAmount, category: UsageCategory): string {
  const count = amount.tokenReported?.[category];
  return count === undefined
    ? m.settingsUsageCoverageUnavailable()
    : m.settingsUsageRecordsOf({ count: String(count), records: String(amount.records) });
}

/** Whether some model in the summary was recorded before models were kept apart. */
export function hasRecordedModels(summary: UsageSummary): boolean {
  return summary.models.some((model) => model.attribution === "recorded");
}

export type UsageReadout = { label: string; value: string; note: string };

/** The three readouts: the total, tasks finished, models represented. */
export function readouts(summary: UsageSummary, unit: UsageUnit): UsageReadout[] {
  const { total } = summary;
  const usage: UsageReadout =
    unit === "tokens"
      ? {
          label: m.settingsUsageReadoutTokens(),
          value: formatAmount(total, unit),
          note: completeTokens(total)
            ? m.settingsUsageReadoutTokensComplete()
            : m.settingsUsageReadoutTokensPartial(),
        }
      : {
          label:
            total.priced > 0 && total.priced < total.records
              ? m.settingsUsageReadoutKnownEstimate()
              : m.settingsUsageReadoutEstimate(),
          value: formatAmount(total, unit),
          note: pricedLine(total),
        };
  return [
    usage,
    {
      label: m.settingsUsageReadoutFinished(),
      value: String(summary.finished),
      note: m.settingsUsageReadoutFinishedNote(),
    },
    {
      label: hasRecordedModels(summary)
        ? m.settingsUsageReadoutRecordedModels()
        : m.settingsUsageReadoutModelsUsed(),
      value: String(summary.models.length),
      note: m.settingsUsageReadoutModelsNote(),
    },
  ];
}

/** Largest first in the unit; an amount with no value in it after every one with a value. */
function byValue(a: UsageAmount, b: UsageAmount, unit: UsageUnit): number {
  const left = usageValue(a, unit);
  const right = usageValue(b, unit);
  if (left === null || right === null) return left === null ? (right === null ? 0 : 1) : -1;
  return right - left;
}

/** Models largest first in the unit; a model with no value in it goes last. */
export function sortedModels(models: readonly UsageModel[], unit: UsageUnit): UsageModel[] {
  return [...models].sort((a, b) => byValue(a.amount, b.amount, unit));
}

export function modelName(model: UsageModel): string {
  return model.name ?? m.settingsUsageModelNotRecorded();
}

/** The line under a model's name: its provider, and how loosely it is named. */
export function modelLine(model: UsageModel): string {
  const provider = model.providerName ?? m.settingsUsageProviderNotRecorded();
  return model.attribution === "recorded"
    ? m.settingsUsageModelLineRecorded({ provider })
    : provider;
}

const ATTRIBUTION_WORDS: Readonly<Record<UsageAttribution, () => string>> = {
  served: m.settingsUsageAttributionServed,
  requested: m.settingsUsageAttributionRequested,
  recorded: m.settingsUsageAttributionRecorded,
};

const PRICE_SOURCE_WORDS: Readonly<Record<UsagePriceSource, () => string>> = {
  "listed-prices": m.settingsUsagePriceListed,
  claude: m.settingsUsagePriceClaude,
  reported: m.settingsUsagePriceReported,
  unrecorded: m.settingsUsagePriceUnrecorded,
};

/** What a model's details say about its name and its estimates. */
export function provenance(model: UsageModel, unit: UsageUnit): string[] {
  const lines = [ATTRIBUTION_WORDS[model.attribution]()];
  if (unit === "tokens") {
    lines.push(m.settingsUsageProvenanceCache());
    return lines;
  }
  const { amount } = model;
  if (amount.priced === 0) {
    lines.push(m.settingsUsageProvenanceUnpriced());
    return lines;
  }
  lines.push(...model.priceSources.map((source) => PRICE_SOURCE_WORDS[source]()));
  lines.push(
    m.settingsUsagePricedSentence({
      priced: String(amount.priced),
      records: String(amount.records),
    }),
  );
  if (amount.split === 0) {
    lines.push(m.settingsUsageNoSplit());
  } else if (amount.split < amount.priced) {
    lines.push(
      m.settingsUsageSplitFor({ split: String(amount.split), priced: String(amount.priced) }),
    );
  }
  return lines;
}

/**
 * A kind of work as Where it went names it: the category names the captain
 * chose on FI3-993, the kind a task's shape saved, never guessed from a title.
 */
export const KIND_WORDS: Readonly<Record<UsageWorkKind, string>> = {
  get plan() {
    return m.settingsUsageKindPlan();
  },
  get research() {
    return m.settingsUsageKindResearch();
  },
  get retrieval() {
    return m.settingsUsageKindRetrieval();
  },
  get reproduce() {
    return m.settingsUsageKindReproduce();
  },
  get implement() {
    return m.settingsUsageKindImplement();
  },
  get fix() {
    return m.settingsUsageKindFix();
  },
  get chore() {
    return m.settingsUsageKindChore();
  },
  get review() {
    return m.settingsUsageKindReview();
  },
  get operation() {
    return m.settingsUsageKindOperation();
  },
};

/** A task with no saved kind, or an unclear one, is other task work in its project. */
export function kindWords(kind: UsageWorkKind | null): string {
  return kind === null ? m.settingsUsageKindOther() : KIND_WORDS[kind];
}

export type WhereRow = { key: string; name: string; amount: UsageAmount };
export type WhereProject = WhereRow & { kinds: WhereRow[] };

/**
 * Where it went as the tab lists it: the Firstmate first, when the work
 * includes it, even with nothing recorded; each project under its own name
 * with its kinds of work; other work last, when there is any. Projects and
 * kinds go largest first in the unit, those with no value in it after, and
 * names break ties.
 */
export function whereRows(
  where: UsageWhere,
  unit: UsageUnit,
  withFirstmate: boolean,
): { firstmate: UsageAmount | null; projects: WhereProject[]; other: UsageAmount | null } {
  const ranked = <T extends WhereRow>(rows: T[]) =>
    rows.sort((a, b) => byValue(a.amount, b.amount, unit) || a.name.localeCompare(b.name));
  return {
    firstmate: withFirstmate || where.firstmate.records > 0 ? where.firstmate : null,
    projects: ranked(
      where.projects.map((project) => ({
        key: project.project?.id ?? "unavailable",
        name: project.project?.name ?? m.settingsUsageProjectUnavailable(),
        amount: project.amount,
        kinds: ranked(
          project.kinds.map((each) => ({
            key: each.kind ?? "other",
            name: kindWords(each.kind),
            amount: each.amount,
          })),
        ),
      })),
    ),
    other: where.other.records > 0 ? where.other : null,
  };
}

export function exactTokens(tokens: number): string {
  return formatNumber(Math.round(tokens));
}

/** A recent task's five figures, in this order, each with its label, worded when shown. */
export function taskFigureLabels(): ReadonlyArray<readonly [UsageCategory | "total", string]> {
  return [
    ["input", m.settingsUsageFigureInput()],
    ["output", m.settingsUsageFigureOutput()],
    ["cacheRead", m.settingsUsageFigureCacheRead()],
    ["cacheWrite", m.settingsUsageFigureCacheWrite()],
    ["total", m.settingsUsageFigureTotal()],
  ];
}

export type TaskFigure = {
  figure: UsageCategory | "total";
  label: string;
  value: string;
  /** How much of the task's records it covers, when not all. */
  coverage: string | null;
};

/**
 * A recent task's figures in the unit: each category over the records that
 * reported it, and the total. A category no record reported is not
 * available, never zero; in dollars only the estimate's recorded parts
 * appear, never a total split after the fact.
 */
export function taskFigures(task: UsageTask, unit: UsageUnit): TaskFigure[] {
  const { amount } = task;
  return taskFigureLabels().map(([figure, label]): TaskFigure => {
    if (figure === "total") {
      if (unit === "usd") {
        return {
          figure,
          label,
          value: amount.priced === 0 ? USAGE_WORDS.notAvailable : dollars(amount.cost ?? 0),
          coverage: amount.priced > 0 && amount.priced < amount.records ? pricedLine(amount) : null,
        };
      }
      return {
        figure,
        label,
        value: amount.counted === 0 ? USAGE_WORDS.notAvailable : exactTokens(usageTokens(amount)),
        coverage:
          amount.counted > 0 && amount.counted < amount.records
            ? m.settingsUsageRecordsOf({
                count: String(amount.counted),
                records: String(amount.records),
              })
            : null,
      };
    }
    if (unit === "usd") {
      const reported = task.costReported[figure];
      return {
        figure,
        label,
        value: reported === 0 ? USAGE_WORDS.notAvailable : dollars(amount.costParts[figure] ?? 0),
        coverage:
          reported > 0 && reported < amount.priced
            ? m.settingsUsagePricedRecordsOf({
                count: String(reported),
                priced: String(amount.priced),
              })
            : null,
      };
    }
    const reported = task.reported[figure];
    return {
      figure,
      label,
      value: reported === 0 ? USAGE_WORDS.notAvailable : exactTokens(amount.tokens[figure]),
      coverage:
        reported > 0 && reported < amount.records
          ? m.settingsUsageRecordsOf({ count: String(reported), records: String(amount.records) })
          : null,
    };
  });
}

/** What a recent task's row says when its figures leave something out. */
export function taskNote(task: UsageTask, unit: UsageUnit): string | null {
  const { amount } = task;
  const categories = ["input", "output", "cacheRead", "cacheWrite"] as const;
  if (unit === "tokens") {
    if (amount.counted === 0) return m.settingsUsageTaskNoTokens();
    return categories.some((category) => task.reported[category] < amount.records)
      ? m.settingsUsageTaskTokensPartial()
      : null;
  }
  if (amount.priced === 0) return m.settingsUsageTaskUnpriced();
  const leavesOut = amount.priced < amount.records;
  if (amount.split === 0) {
    return leavesOut ? m.settingsUsageTaskLeavesOutNoSplit() : m.settingsUsageNoSplit();
  }
  if (categories.some((category) => task.costReported[category] < amount.priced)) {
    return leavesOut
      ? m.settingsUsageTaskLeavesOutFewerRecords()
      : m.settingsUsageTaskFewerRecords();
  }
  return leavesOut ? m.settingsUsageTaskLeavesOut() : null;
}

/** "Created Oct 5, 3:12 PM": when a recent task was created, in local time. */
export function createdWords(at: number): string {
  const when = formatLanguageDateTime(new Date(at), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return m.settingsUsageCreated({ when });
}

export function taskCount(shown: number, matching: number): string {
  if (shown >= matching) {
    return matching === 1
      ? m.settingsUsageTaskCountOne()
      : m.settingsUsageTaskCountAll({ count: String(matching) });
  }
  return m.settingsUsageTaskCountSome({ shown: String(shown), count: String(matching) });
}

/** The milestone strip: finished work, never tokens. */
export function milestoneWords(finishedEver: number): { title: string; note: string } {
  const { reached, next } = usageMilestone(finishedEver);
  const finished =
    finishedEver === 0
      ? m.settingsUsageMilestoneNone()
      : finishedEver === 1
        ? m.settingsUsageMilestoneFinishedOne()
        : m.settingsUsageMilestoneFinished({ count: String(finishedEver) });
  const where =
    next === null
      ? m.settingsUsageMilestoneReached({ count: String(reached) })
      : reached === null
        ? m.settingsUsageMilestoneFirst()
        : m.settingsUsageMilestoneNext({ count: String(next) });
  return {
    title: m.settingsUsageMilestoneTitle({ finished, where }),
    note: m.settingsUsageMilestoneNote(),
  };
}

/**
 * The period's usage in one line, as the phone's Settings row says it:
 * "17.26M tokens · Last 30 days", or that nothing is recorded.
 */
export function usageSummaryLine(summary: UsageSummary): string {
  if (summary.total.records === 0) return m.settingsUsageEmptyTitle();
  const tokens = usageValue(summary.total, "tokens");
  const period = PERIOD_WORDS[summary.query.period];
  return tokens === null
    ? period
    : m.settingsUsageSummary({ tokens: compactTokens(tokens), period });
}
