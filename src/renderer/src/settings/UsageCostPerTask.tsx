import * as m from "@shared/i18n/messages.generated";
import {
  type CostPoint,
  type CostSelection,
  type CostSeries,
  costDayEnds,
  costPoint,
  costSeries,
  costValues,
  type UsagePeriod,
  type UsageTaskCosts,
  type UsageUnit,
} from "@shared/usage";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { appReadExecutor } from "../plugins/reads/appExecutor";
import { SettingError } from "./settingRows";
import {
  type CostOption,
  costFilterValue,
  costKindOptions,
  costLegend,
  costMiddleHalf,
  costPointWords,
  costProjectOptions,
  costReadouts,
  costUnitLine,
  formatUsage,
  momentDate,
} from "./usageWords";

/**
 * Settings → Usage's Cost per task (docs/usage.md; INF-6217's plan, the
 * captain's picks): one line of the median finished task's cost, each task
 * with its reviews, over a sliding seven-day window, with the middle half
 * of the window's tasks as a band behind it. It follows the tab's period
 * and unit; its Projects and Kinds filters open at All on every opening
 * of the tab. It reads `usage.taskCosts`; the medians are the shared
 * module's pure math.
 */
export function CostPerTask({
  period,
  unit,
  selection,
  onSelection,
}: {
  period: UsagePeriod;
  unit: UsageUnit;
  /** The filters, kept by the tab so a new period or work keeps them. */
  selection: CostSelection;
  onSelection: (next: CostSelection) => void;
}) {
  const [costs, setCosts] = useState<UsageTaskCosts | null>(null);
  const [failed, setFailed] = useState(false);
  const { projects, kinds } = selection;

  useEffect(() => {
    setFailed(false);
    return appReadExecutor().subscribe(
      "usage.taskCosts",
      { period },
      {
        onValue: (value) => {
          setCosts(value as UsageTaskCosts);
          setFailed(false);
        },
        onError: () => setFailed(true),
      },
    );
  }, [period]);

  const shown = costs?.query.period === period ? costs : null;
  const series = useMemo(
    () => (shown ? costSeries(shown, selection, unit) : null),
    [shown, selection, unit],
  );

  return (
    <section className="fm-usage-section" data-usage-cost="">
      <div className="fm-usage-section-head">
        <h3>{m.settingsUsageCostHeading()}</h3>
        <span className="fm-usage-muted">{costUnitLine(unit)}</span>
      </div>
      <p className="fm-usage-muted fm-usage-cost-lead">{m.settingsUsageCostLead()}</p>
      {shown && (
        <div className="fm-usage-cost-filters">
          <CostFilter
            filter="projects"
            label={m.settingsUsageCostProjects()}
            all={m.settingsUsageCostAllProjects()}
            options={costProjectOptions(shown.tasks, shown.since, projects)}
            picked={projects}
            onPick={(next) => onSelection({ ...selection, projects: next })}
          />
          <CostFilter
            filter="kinds"
            label={m.settingsUsageCostKinds()}
            all={m.settingsUsageCostAllKinds()}
            options={costKindOptions(shown.tasks, shown.since, kinds)}
            picked={kinds}
            onPick={(next) => onSelection({ ...selection, kinds: next })}
          />
        </div>
      )}
      {failed && !shown && (
        <SettingError error={m.settingsUsageCostFailed()} surface="usage-cost" />
      )}
      {shown && series ? (
        <CostBody costs={shown} selection={selection} series={series} unit={unit} />
      ) : (
        !failed && <p className="fm-usage-muted">{m.settingsUsageCostReading()}</p>
      )}
    </section>
  );
}

export function CostBody({
  costs,
  selection,
  series,
  unit,
}: {
  costs: UsageTaskCosts;
  selection: CostSelection;
  series: CostSeries;
  unit: UsageUnit;
}) {
  const [pointed, setPointed] = useState<CostPoint | null>(null);
  const drawn = series.points.some((point) => point.median !== null);
  // The figure each readout words, for a reader that checks it against the read.
  const figures = [series.now.median, series.start?.median ?? null, series.change];
  return (
    <>
      <div className="fm-usage-readouts fm-usage-cost-readouts">
        {costReadouts(series, unit).map((readout, index) => (
          <div
            key={readout.label}
            className="fm-usage-readout"
            data-usage-cost-readout={["now", "start", "change"][index]}
            data-usage-value={figures[index] ?? ""}
          >
            <span className="fm-usage-readout-label">{readout.label}</span>
            <span className="fm-usage-readout-value fm-usage-mono">{readout.value}</span>
            <span className="fm-usage-muted">{readout.note}</span>
          </div>
        ))}
      </div>
      {drawn ? (
        <CostChart series={series} unit={unit} since={costs.since} onPoint={setPointed} />
      ) : (
        <p className="fm-usage-muted fm-usage-cost-empty" data-usage-cost-empty="">
          {m.settingsUsageCostTooFew()}
        </p>
      )}
      <p className="fm-usage-legend" data-usage-cost-legend="">
        {pointed ? costPointWords(pointed, unit) : costLegend(series, unit)}
      </p>
      <CostValues costs={costs} selection={selection} unit={unit} />
    </>
  );
}

const WIDTH = 750;
const HEIGHT = 200;
const LEFT = 64;
const RIGHT = 8;
const TOP = 8;
const BOTTOM = 22;

/** The top of the scale: the first round number at or above the highest value. */
function scaleTop(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((each) => value / power <= each) ?? 10;
  return step * power;
}

/**
 * The line and its band, drawn by hand in the tab's own tokens: three
 * hairlines with their values, the middle half in `--accent-dim`, the
 * median in `--accent`, broken where a window has too few tasks. Resting
 * the pointer on it names that point in the legend; the Values table is
 * the keyboard's way to every value.
 */
function CostChart({
  series,
  unit,
  since,
  onPoint,
}: {
  series: CostSeries;
  unit: UsageUnit;
  since: number | null;
  onPoint: (point: CostPoint | null) => void;
}) {
  const [at, setAt] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const { points } = series;
  const top = scaleTop(Math.max(...points.map((point) => point.q3 ?? point.median ?? 0), 0) * 1.05);
  const plotWidth = WIDTH - LEFT - RIGHT;
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const x = (index: number) => LEFT + (plotWidth * index) / Math.max(points.length - 1, 1);
  const y = (value: number) => TOP + plotHeight - (value / top) * plotHeight;
  const runs: { index: number; point: CostPoint }[][] = [];
  let run: { index: number; point: CostPoint }[] = [];
  points.forEach((point, index) => {
    if (point.median === null) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push({ index, point });
  });
  if (run.length) runs.push(run);
  const pointed = at === null ? undefined : points[at];

  const point = (clientX: number) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const local = ((clientX - box.left) / box.width) * WIDTH;
    const index = Math.round(((local - LEFT) / plotWidth) * (points.length - 1));
    const clamped = Math.min(Math.max(index, 0), points.length - 1);
    setAt(clamped);
    onPoint(points[clamped] ?? null);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the pointer's rest names a point; the Values table is the keyboard's way to every value.
    <div
      className="fm-usage-cost-chart"
      onMouseMove={(event) => point(event.clientX)}
      onMouseLeave={() => {
        setAt(null);
        onPoint(null);
      }}
    >
      <svg
        ref={svg}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        role="img"
        aria-label={
          unit === "usd" ? m.settingsUsageCostChartUsd() : m.settingsUsageCostChartTokens()
        }
      >
        {[0, 0.5, 1].map((share) => (
          <g key={share}>
            <line
              x1={LEFT}
              x2={WIDTH - RIGHT}
              y1={y(top * share)}
              y2={y(top * share)}
              className="fm-usage-cost-grid"
            />
            <text
              x={LEFT - 8}
              y={y(top * share) + 4}
              textAnchor="end"
              className="fm-usage-cost-tick"
            >
              {formatUsage(top * share, unit)}
            </text>
          </g>
        ))}
        {runs.map((each) => (
          <g key={each[0]?.index}>
            <polygon
              className="fm-usage-cost-band"
              data-usage-cost-band=""
              points={[
                ...each.map(({ index, point: p }) => `${x(index)},${y(p.q3 ?? 0)}`),
                ...[...each].reverse().map(({ index, point: p }) => `${x(index)},${y(p.q1 ?? 0)}`),
              ].join(" ")}
            />
            <polyline
              className="fm-usage-cost-line"
              data-usage-cost-line=""
              points={each
                .map(({ index, point: p }) => `${x(index)},${y(p.median ?? 0)}`)
                .join(" ")}
            />
          </g>
        ))}
        <text x={LEFT} y={HEIGHT - 4} className="fm-usage-cost-tick">
          {since === null ? "" : momentDate(since)}
        </text>
        <text x={WIDTH - RIGHT} y={HEIGHT - 4} textAnchor="end" className="fm-usage-cost-tick">
          {m.settingsUsageToday()}
        </text>
        {at !== null && (
          <g>
            <line
              x1={x(at)}
              x2={x(at)}
              y1={TOP}
              y2={TOP + plotHeight}
              className="fm-usage-cost-cross"
            />
            {pointed?.median != null && (
              <circle cx={x(at)} cy={y(pointed.median)} r={4} className="fm-usage-cost-dot" />
            )}
          </g>
        )}
      </svg>
    </div>
  );
}

/** Every local day's window, ending at the day's end and today now, as a table. */
function CostValues({
  costs,
  selection,
  unit,
}: {
  costs: UsageTaskCosts;
  selection: CostSelection;
  unit: UsageUnit;
}) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => {
    if (!open) return [];
    const { values } = costValues(costs, selection, unit);
    return costDayEnds(costs).map((end) => costPoint(values, end));
  }, [open, costs, selection, unit]);
  return (
    <details data-usage-cost-values="" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{m.settingsUsageCostValues()}</summary>
      {open && (
        <table>
          <thead>
            <tr>
              <th scope="col">{m.settingsUsageLocalDate()}</th>
              <th scope="col">{m.settingsUsageCostMedian()}</th>
              <th scope="col">{m.settingsUsageCostMiddleHalf()}</th>
              <th scope="col">{m.settingsUsageCostTasks()}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.at}>
                <td>{index === rows.length - 1 ? m.settingsUsageToday() : momentDate(row.at)}</td>
                <td>{formatUsage(row.median, unit)}</td>
                <td>{costMiddleHalf(row, unit)}</td>
                <td>{row.tasks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

/** The app's down chevron (ModelsSection, PanelExpandChevron); turned up while the menu is open. */
const chevron = (
  <svg
    className="fm-usage-cost-filter-chevron"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

/**
 * A filter of checkboxes in a disclosure: its name and what it holds on
 * the closed row; All, then each choice with its tasks in the period. No
 * box ticked is All. Escape closes it and leaves focus on its row; a press
 * anywhere outside it, or focus moving outside it, closes it too, so the
 * two filters' menus never lie over each other.
 */
function CostFilter<K extends string | null>({
  filter,
  label,
  all,
  options,
  picked,
  onPick,
}: {
  filter: "projects" | "kinds";
  label: string;
  all: string;
  options: CostOption<K>[];
  picked: ReadonlySet<K> | null;
  onPick: (next: ReadonlySet<K> | null) => void;
}) {
  const box = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null) =>
      target instanceof Node && !box.current?.contains(target);
    const close = (event: Event) => {
      if (box.current && outside(event.target)) box.current.open = false;
    };
    // A press on a part of the menu that takes no focus, such as a choice's
    // name, focuses the menu's fieldset (tabIndex -1), not the Settings panel
    // around it, so its focusin stays inside. Closing the menu during that
    // press would hide the pressed text as Chromium starts selecting it,
    // which crashes the page.
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", close);
    };
  }, [open]);
  const onKeyDown = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key !== "Escape" || !box.current?.open) return;
    event.stopPropagation();
    box.current.open = false;
    box.current.querySelector("summary")?.focus();
  };
  const toggle = (key: K) => {
    const next = new Set(picked ?? []);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onPick(next.size === 0 ? null : next);
  };
  return (
    <details
      ref={box}
      className="fm-usage-cost-filter"
      data-usage-cost-filter={filter}
      onKeyDown={onKeyDown}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="fm-usage-cost-filter-label">{label}</span>{" "}
        <span data-usage-cost-filter-value="">
          {costFilterValue(options as CostOption<string | null>[], picked, all)}
        </span>
        {chevron}
      </summary>
      <fieldset className="fm-usage-cost-menu" tabIndex={-1}>
        <legend className="fm-usage-cost-menu-legend">{label}</legend>
        <div className="fm-usage-cost-menu-list">
          <label>
            <input
              type="checkbox"
              checked={picked === null}
              onChange={() => onPick(null)}
              data-usage-cost-all=""
            />
            <span>{all}</span>
          </label>
          {options.map((option) => (
            <label key={option.key ?? ""}>
              <input
                type="checkbox"
                value={option.key ?? ""}
                checked={picked?.has(option.key) ?? false}
                onChange={() => toggle(option.key)}
              />
              <span>{option.name}</span>
              <span className="fm-usage-muted fm-usage-mono">{option.tasks}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </details>
  );
}
