import { SECRET_ASK_CARD_WORDS, secretsNamed } from "@shared/secrets";
import { escapeCardText } from "../orchestrator/cardText";
import type { WaitingSecretAsk } from "./asks";

/** The card id of an ask, by its asker (a task, or null for the first mate) and the asker's id. */
export function secretAskCardId(task: string | null, id: string): string {
  return `card-secrets-ask-${task ?? "firstmate"}-${id}`;
}

/** The ask card's title: the secrets it asks for and who asks. */
export function secretAskTitle(ask: WaitingSecretAsk, taskTitle: string | null): string {
  return SECRET_ASK_CARD_WORDS.title(
    secretsNamed(ask.fields.map((field) => field.name)),
    ask.task ? (taskTitle ?? ask.task) : null,
  );
}

/**
 * The ask card's body (docs/secrets.md, "Asking to keep a secret"): one row
 * per secret with its place and what it replaces, the asker's reason in
 * quotes with who wrote it, and what keeping allows. It holds no field: the
 * window draws the masked fields outside the card's page, from its Keep
 * button (`secretKeepFields`). A line marked `data-inf-secret-elsewhere`
 * shows only where no field is drawn, an older window or phone: the frame's
 * own stylesheet hides it.
 */
export function secretAskBody(ask: WaitingSecretAsk, notice?: string): string {
  const text = escapeCardText;
  const words = SECRET_ASK_CARD_WORDS;
  const many = ask.fields.length > 1;
  const row = (name: string, value: string, quiet = false) =>
    `<div><dt>${text(name)}</dt><dd${quiet ? ' class="secret-ask-quiet"' : ""}>${value}</dd></div>`;
  const secrets = ask.fields
    .map((field) => {
      const place = field.place
        ? `<span class="secret-ask-place">${text(words.place)} <b>${text(field.place)}</b></span>`
        : "";
      const replaces = field.replaces
        ? `<small data-secret-replaces="${text(field.replaces.ref)}">${text(words.replaces(field.replaces.version))}</small>`
        : "";
      return `<li data-secret-field="${text(field.id)}"><b data-secret-name>${text(field.name)}</b>${place}${replaces}</li>`;
    })
    .join("");
  return `<style>
    .secret-ask { max-width:44rem; color:var(--fg-2); }
    .secret-ask :is(p, dl, ul) { max-width:none; }
    .secret-ask [role="status"] { margin:0 0 var(--space-3); color:var(--fg-1); }
    .secret-ask dl { display:grid; row-gap:10px; margin:0; }
    .secret-ask dl > div { display:grid; grid-template-columns:8.5rem minmax(0,1fr); column-gap:var(--space-4); align-items:baseline; }
    .secret-ask dt { font-size:var(--text-sm); color:var(--fg-3); }
    .secret-ask dd { margin:0; min-width:0; color:var(--fg-1); overflow-wrap:anywhere; }
    .secret-ask dd.secret-ask-quiet { color:var(--fg-2); }
    .secret-ask b { font-weight:500; color:var(--fg-1); }
    .secret-ask small { display:block; margin-top:2px; font-size:var(--text-sm); color:var(--fg-3); }
    .secret-ask ul { list-style:none; margin:0; padding:0; display:grid; row-gap:4px; }
    .secret-ask li { margin:0; }
    .secret-ask-place { margin-left:8px; font-size:var(--text-sm); color:var(--fg-3); }
    .secret-ask-place b { font-weight:400; color:var(--fg-2); }
    .secret-ask-fine { margin:14px 0 0; padding-top:14px; border-top:1px solid var(--line-1); color:var(--fg-2); }
    .secret-ask-elsewhere { margin:10px 0 0; font-size:var(--text-sm); color:var(--fg-3); }
    @media (max-width:480px) {
      .secret-ask dl > div { grid-template-columns:minmax(0,1fr); row-gap:2px; }
      .secret-ask-place { display:block; margin-left:0; }
    }
  </style>
  <div class="secret-ask">
    ${notice ? `<p role="status">${text(notice)}</p>` : ""}
    <dl aria-label="The ask">
      ${row(many ? words.secrets : words.secret, `<ul aria-label="Secrets asked for">${secrets}</ul>`)}
      ${row(words.reason, `“${text(ask.reason)}”<small>${text(words.asked(ask.task))}</small>`, true)}
    </dl>
    <p class="secret-ask-fine">${text(words.keeps(ask.task, many))}</p>
    <p class="secret-ask-elsewhere" data-inf-secret-elsewhere>${text(words.elsewhere)}</p>
  </div>`;
}
