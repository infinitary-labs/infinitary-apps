import { SECRET_BRING_CARD_WORDS, SECRET_BRING_ELSEWHERE_HIDDEN } from "@shared/secretBring";
import { escapeCardText } from "../orchestrator/cardText";
import type { WaitingBring } from "./bring";

export function bringCardId(task: string, id: string): string {
  return `card-secrets-bring-${task}-${id}`;
}

/** The bring card's title: how many secrets and from which tool, in the asker's word. */
export function bringCardTitle(bring: WaitingBring): string {
  return SECRET_BRING_CARD_WORDS.title(bring.rows ? bring.rows.length : null, bring.tool);
}

/** A program and its arguments as one line a person can read: each argument quoted only when it must be. */
export function commandLine(program: string, args: readonly string[]): string {
  const quoted = (arg: string) =>
    /^[A-Za-z0-9_./:=+@%,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
  return [program, ...args].map(quoted).join(" ");
}

/**
 * The bring card's body (docs/secrets.md, "Bringing secrets from another
 * tool"): the tool in the asker's word, the exact program by its real path
 * with its arguments and folder, or the exact file, the asker's reason in
 * quotes, and what the press does and never does. The rows the captain
 * ticks are not here: the window draws them outside the card's page, from
 * its Bring into Secrets button (`secretBringRows`), and before a read the
 * body says the names come after it. Every word an agent wrote is escaped.
 */
export function bringCardBody(bring: WaitingBring, notice?: string): string {
  const text = escapeCardText;
  const words = SECRET_BRING_CARD_WORDS;
  const row = (name: string, value: string, quiet = false) =>
    `<div><dt>${text(name)}</dt><dd${quiet ? ' class="secret-bring-quiet"' : ""}>${value}</dd></div>`;
  const source = bring.source;
  const what =
    source.kind === "run"
      ? row(
          words.runs,
          `<code data-secret-bring-runs>${text(commandLine(source.program.path, source.argv.slice(1)))}</code>`,
        ) + row(words.folder, `<code>${text(source.folder)}</code>`)
      : row(words.reads, `<code data-secret-bring-reads>${text(source.file.path)}</code>`);
  return `<style>
    .secret-bring { max-width:44rem; color:var(--fg-2); }
    .secret-bring :is(p, dl) { max-width:none; }
    .secret-bring [role="status"] { margin:0 0 var(--space-3); color:var(--fg-1); }
    .secret-bring dl { display:grid; row-gap:10px; margin:0; }
    .secret-bring dl > div { display:grid; grid-template-columns:8.5rem minmax(0,1fr); column-gap:var(--space-4); align-items:baseline; }
    .secret-bring dt { font-size:var(--text-sm); color:var(--fg-3); }
    .secret-bring dd { margin:0; min-width:0; color:var(--fg-1); overflow-wrap:anywhere; }
    .secret-bring dd.secret-bring-quiet { color:var(--fg-2); }
    .secret-bring code { font-family:var(--font-mono); font-size:var(--text-sm); }
    .secret-bring small { display:block; margin-top:2px; font-size:var(--text-sm); color:var(--fg-3); }
    .secret-bring-fine { margin:12px 0 0; color:var(--fg-3); font-size:var(--text-sm); }
    @media (max-width:480px) {
      .secret-bring dl > div { grid-template-columns:minmax(0,1fr); row-gap:2px; }
    }
  </style>
  <div class="secret-bring">
    ${notice ? `<p role="status">${text(notice)}</p>` : ""}
    <dl aria-label="The bring">
      ${row(words.from, text(words.fromValue(bring.tool)))}
      ${what}
      ${
        bring.unlocks
          ? row(
              words.unlocks,
              `${bring.unlocks
                .map(
                  ({ name, label, ref, version, place }) =>
                    `<div><code>${text(name)}</code> ← ${text(label)}${place ? ` (${text(place)})` : ""} · <code>${text(ref)}</code> · ${text(words.version(version))}</div>`,
                )
                .join("")}<small>${text(words.unlockOnce)}</small>`,
            )
          : ""
      }
      ${row(words.reason, `“${text(bring.reason)}”<small>${text(words.asked)}</small>`, true)}
    </dl>
    ${bring.rows === null ? `<p class="secret-bring-fine">${text(words.readFirst)}</p>` : ""}
    <p class="secret-bring-fine">${text(words.fine)}</p>
    ${bring.rows === null ? "" : `${SECRET_BRING_ELSEWHERE_HIDDEN}${text(words.elsewhere)}</p>`}
  </div>`;
}
