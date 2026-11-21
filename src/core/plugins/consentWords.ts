import { PLACE_SAID } from "@shared/deviceNames";
import { inLanguage } from "@shared/i18n/current";
import { formatList } from "@shared/i18n/format";
import { SOURCE_LANGUAGE } from "@shared/i18n/languages";
import { said, saidMark } from "@shared/i18n/said";
import {
  type ConsentSummary,
  consentSummary,
  type PluginCapabilities,
} from "@shared/plugins/manifest";
import { READ_WORDS, viewWords } from "@shared/vocabulary";

/**
 * The consent cards' bodies (`pluginInstaller.ts`, A2a): a runbook's add
 * card and a panel's own card say what is added in the same labeled rows
 * (`dl.inf-grants`), one quiet line of what holds for every panel, and the
 * exact names, each integration's rule and reason, the moves fine print and
 * what a panel keeps under Full details. Every word is a catalog message
 * placed with `saidMark`, so each reader words it in its own language.
 */

/** The consent card's title: adding a panel, or a newer version that asks for something different. */
export function panelConsentTitle(title: string, name: string, update = false): string {
  return update ? `Update the ${title} panel?` : `Add the ${title} panel by ${name}?`;
}

/** Where the added thing comes from: its author, then the whole source with a folder's own name lit. */
export type ConsentSource = { author: string; spec: string; folder: boolean };

/** One panel a runbook shows, by its title, with what it was checked to ask for. */
export type ConsentPanel = { title: string; capabilities: PluginCapabilities };

/** A runbook's add card: its description, the rows, the quiet line and, with panels, Full details. */
export function runbookConsentBody(input: {
  description: string;
  source: ConsentSource;
  projects: boolean;
  replacement?: string;
  panels: readonly ConsentPanel[];
}): string {
  const panels = input.panels.map((panel) => ({
    ...panel,
    summary: consentSummary(panel.capabilities),
  }));
  const through = panels.some((panel) => panel.summary.integrations.length > 0);
  const count = panels.length;
  const rows = [
    fromRow(input.source),
    row(
      said("cardConsentReaches"),
      saidMark(
        input.projects ? said("cardConsentReachesNamed") : said("cardConsentReachesAll"),
        "dd",
      ),
    ),
    ...(input.replacement
      ? [
          row(
            said("cardConsentTurnsOff"),
            `<dd><b>${escapeHtml(input.replacement)}</b> ${saidMark(said("cardConsentTurnBackOn"), "span", 'class="inf-grants-quiet"')}</dd>`,
          ),
        ]
      : []),
    ...(count > 0
      ? [
          `${saidMark(said("cardConsentShowsPanels", { count }), "dt")}${panels
            .map(
              (panel) =>
                `<dd><b>${escapeHtml(panel.title)}</b><span class="inf-grants-lines">${permissionLines(panel.summary).join("")}</span></dd>`,
            )
            .join("")}`,
        ]
      : []),
  ];
  const note =
    count === 0
      ? said("cardConsentGuidanceOnly")
      : through
        ? said("cardConsentRunbookPanelsThrough", { count, here: PLACE_SAID.this })
        : said("cardConsentRunbookPanels", { count, here: PLACE_SAID.this });
  return (
    (input.description.trim() ? `<p>${escapeHtml(input.description)}</p>` : "") +
    `<dl class="inf-grants">${rows.join("")}</dl>` +
    saidMark(note, "p", 'class="inf-grants-note"') +
    (count > 0
      ? fullDetails(
          panels
            .map((panel) => `<h6>${escapeHtml(panel.title)}</h6>${detailRows(panel.summary)}`)
            .join(""),
        )
      : "")
  );
}

/**
 * A panel's own card: the rows of what it reads, uses and moves, the quiet
 * line and Full details. An update keeps its opening sentence above the rows.
 */
export function panelConsentBody(input: {
  source: ConsentSource;
  capabilities: PluginCapabilities;
  update?: { title: string; version: string };
}): string {
  const summary = consentSummary(input.capabilities);
  const reads = readList(summary);
  const through = summary.integrations.length > 0;
  const rows = [
    fromRow(input.source),
    reads
      ? row(
          said("cardConsentReads"),
          `<dd>${escapeHtml(reads[0]?.toUpperCase() + reads.slice(1))}</dd>`,
        )
      : row(said("cardConsentReads"), saidMark(said("cardConsentNothingOfYours"), "dd")),
    ...(through
      ? [
          row(
            said("cardConsentUses"),
            summary.integrations.map((use) => `<dd>${escapeHtml(useNames(use))}</dd>`).join(""),
          ),
        ]
      : []),
    ...(summary.moves
      ? [row(said("cardConsentMoves"), saidMark(said("cardConsentMovesValue"), "dd"))]
      : []),
  ];
  const note = through
    ? said("cardConsentPanelNoteThrough", { here: PLACE_SAID.this })
    : said("cardConsentPanelNote", { here: PLACE_SAID.this });
  return (
    (input.update
      ? `<p>A new version of <b>${escapeHtml(input.update.title)}</b>, a panel by ${escapeHtml(input.source.author)}, asks for something different from what you agreed to. Version ${escapeHtml(input.update.version)}.</p>`
      : "") +
    `<dl class="inf-grants">${rows.join("")}</dl>` +
    saidMark(note, "p", 'class="inf-grants-note"') +
    fullDetails(detailRows(summary))
  );
}

/** The From row: the author, then the whole source, a folder's own name lit. */
function fromRow(source: ConsentSource): string {
  const cut = source.folder ? source.spec.replace(/[\\/]+$/, "").search(/[^\\/]*$/) : -1;
  const spec =
    cut > 0
      ? `${escapeHtml(source.spec.slice(0, cut))}<b>${escapeHtml(source.spec.slice(cut).replace(/[\\/]+$/, ""))}</b>`
      : escapeHtml(source.spec);
  return row(
    said("cardConsentFrom"),
    `<dd><b>${escapeHtml(source.author)}</b> <code class="inf-grants-source">${spec}</code></dd>`,
  );
}

function row(label: Parameters<typeof saidMark>[0], value: string): string {
  return `${saidMark(label, "dt")}${value}`;
}

/** One line per permission under a panel's name on a runbook's card: what it reads, uses and moves. */
function permissionLines(summary: ConsentSummary): string[] {
  const reads = readList(summary);
  return [
    saidMark(
      reads ? said("cardConsentReadsList", { list: reads }) : said("cardConsentReadsNothing"),
    ),
    ...summary.integrations.map((use) =>
      saidMark(said("cardConsentUsesLine", { integration: use.integration, names: namesOf(use) })),
    ),
    ...(summary.moves ? [saidMark(said("cardConsentMovesLine"))] : []),
  ];
}

/** What a panel reads, in the captain's words, as one English list: the words are the vocabulary's. */
function readList(summary: ConsentSummary): string | null {
  const words = [
    ...summary.reads.map((name) => READ_WORDS[name] ?? name),
    ...summary.views.map((view) => viewWords(view)),
  ];
  return words.length > 0 ? inLanguage(SOURCE_LANGUAGE, () => formatList(words)) : null;
}

function namesOf(use: ConsentSummary["integrations"][number]): string {
  return [...(use.actions ?? []), ...(use.events ?? [])].join(", ");
}

function useNames(use: ConsentSummary["integrations"][number]): string {
  return `${use.integration}: ${namesOf(use)}`;
}

/** The exact names, each integration's rule and reason, the moves fine print and what it keeps. */
function detailRows(summary: ConsentSummary): string {
  const names = [...summary.reads, ...summary.views];
  const rows = [
    ...(names.length > 0 ? [row(said("cardConsentReads"), `<dd>${codes(names)}</dd>`)] : []),
    ...(summary.integrations.length > 0
      ? [
          row(
            said("cardConsentUses"),
            summary.integrations
              .map(
                (use) =>
                  `<dd>${[
                    ...(use.actions?.length
                      ? [
                          saidMark(
                            said("cardConsentUsesActions", {
                              count: use.actions.length,
                              integration: use.integration,
                              names: use.actions.join(", "),
                            }),
                          ),
                        ]
                      : []),
                    ...(use.events?.length
                      ? [
                          saidMark(
                            said("cardConsentUsesEvents", {
                              count: use.events.length,
                              integration: use.integration,
                              names: use.events.join(", "),
                            }),
                          ),
                        ]
                      : []),
                    saidMark(said("cardConsentUsesWhy", { why: use.why })),
                  ].join(" ")}</dd>`,
              )
              .join(""),
          ),
        ]
      : []),
    ...(summary.moves
      ? [row(said("cardConsentMoves"), saidMark(said("cardConsentMovesDetail"), "dd"))]
      : []),
    row(
      said("cardConsentKeeps"),
      saidMark(
        summary.storageBytes === null
          ? said("cardConsentKeepsLittle")
          : said("cardConsentKeepsUpTo", { size: byteWords(summary.storageBytes) }),
        "dd",
      ),
    ),
  ];
  return `<dl class="inf-grants">${rows.join("")}</dl>`;
}

function fullDetails(inner: string): string {
  return `<details class="inf-grants-more">${saidMark(said("cardConsentFullDetails"), "summary")}${inner}</details>`;
}

function codes(names: readonly string[]): string {
  return names.map((name) => `<code>${escapeHtml(name)}</code>`).join(", ");
}

function byteWords(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
