import { SECRET_ASK_CARD_WORDS } from "@shared/secrets";
import { escapeCardText } from "../orchestrator/cardText";
import type { WaitingSecretAsk } from "./asks";

/** The card id of an ask, by its asker (a task, or null for the first mate) and the asker's id. */
export function secretAskCardId(task: string | null, id: string): string {
  return `card-secrets-ask-${task ?? "firstmate"}-${id}`;
}

/** The ask card's title: the secrets it asks for, Replace when every one replaces a saved secret. */
export function secretAskTitle(ask: WaitingSecretAsk): string {
  return SECRET_ASK_CARD_WORDS.title(
    ask.fields.map((field) => field.name),
    ask.fields.every((field) => field.replaces),
  );
}

/**
 * The ask card's body (docs/secrets.md, "Asking to keep a secret";
 * INF-5516's plan): one column at one measure, the asker's reason in quotes
 * with who wrote it, then, when the asker gave one, its "How to get it" part
 * as `secretAskHow` drew it, with who wrote that. Each secret's name, place
 * and the version it replaces are said once, beside its field: the window
 * draws the masked fields outside the card's page, from its Save button
 * (`secretKeepFields`), so nothing in this body can read them. A line
 * marked `data-inf-secret-elsewhere` shows only where no field is drawn, an
 * older window or phone: the frame's own stylesheet hides it. The asker's
 * own words, its reason and its how-to, take the direction of their own
 * language (`dir="auto"`), so English steps read left to right in Arabic.
 */
export function secretAskBody(
  ask: WaitingSecretAsk,
  taskTitle: string | null,
  notice?: string,
): string {
  const text = escapeCardText;
  const words = SECRET_ASK_CARD_WORDS;
  const how = ask.how
    ? `<section class="secret-ask-how" aria-labelledby="secret-ask-how">
      <h3 id="secret-ask-how">${text(words.how(ask.fields.length > 1))}</h3>
      <div class="secret-ask-how-body" dir="auto">${ask.how}</div>
      <p class="secret-ask-by">${text(words.by(ask.task))}</p>
    </section>`
    : "";
  return `<style>
    .secret-ask { max-width:44rem; color:var(--fg-2); }
    .secret-ask :is(p, ul, ol, dl, table, pre, blockquote, details, figure) { max-width:none; }
    .secret-ask [role="status"] { margin:0 0 var(--space-3); color:var(--fg-1); }
    .secret-ask-reason { margin:0; color:var(--fg-1); overflow-wrap:anywhere; }
    .secret-ask-asked { margin:2px 0 0; font-size:var(--text-sm); color:var(--fg-3); overflow-wrap:anywhere; }
    .secret-ask-how { margin-top:var(--space-4); }
    .secret-ask-how > h3 { margin:0 0 var(--space-2); font:11px var(--font-mono); letter-spacing:var(--tracking-label); text-transform:uppercase; color:var(--fg-3); }
    .secret-ask-how-body { color:var(--fg-1); overflow-wrap:anywhere; }
    .secret-ask-how-body > :last-child { margin-bottom:0; }
    .secret-ask-how-body :is(h3, h4, h5) { margin:var(--space-3) 0 var(--space-1); font-size:var(--text-sm); }
    .secret-ask-how-body > :is(h3, h4, h5):first-child { margin-top:0; }
    .secret-ask-how-body ol { list-style:none; padding:0; counter-reset:secret-ask-step; display:grid; row-gap:var(--space-2); }
    .secret-ask-how-body ol > li { counter-increment:secret-ask-step; position:relative; margin:0; padding-inline-start:32px; min-height:22px; }
    .secret-ask-how-body ol > li::before { content:counter(secret-ask-step); position:absolute; inset-inline-start:0; top:1px; box-sizing:border-box; width:20px; height:20px; font:11px/18px var(--font-mono); text-align:center; color:var(--fg-2); border:1px solid var(--line-2); border-radius:50%; }
    .secret-ask-how-body li > :last-child { margin-bottom:0; }
    .secret-ask-how-body ul.inf-grid { list-style:none; margin:6px 0 0; padding:8px 12px; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:4px 12px; background:var(--bg-1); border:1px solid var(--line-1); border-radius:var(--radius-m); }
    .secret-ask-how-body ul.inf-grid > li { margin:0; }
    .secret-ask-how-body :not(pre) > code { padding:1px 5px; background:var(--bg-1); border:1px solid var(--line-1); border-radius:var(--radius-s); }
    .secret-ask-how-body ul.inf-grid code { padding:0; background:none; border:0; }
    .secret-ask-how-body pre { padding:8px 12px; background:var(--bg-1); border:1px solid var(--line-1); border-radius:var(--radius-m); overflow-x:auto; }
    .secret-ask-how-body a { font-family:var(--font-mono); font-size:var(--text-sm); color:var(--accent); text-decoration:underline; text-underline-offset:2px; overflow-wrap:anywhere; }
    .secret-ask-how-body table { width:100%; border-collapse:collapse; font-size:var(--text-sm); }
    .secret-ask-how-body :is(th, td) { padding:4px 8px; border-bottom:1px solid var(--line-1); text-align:start; vertical-align:top; }
    .secret-ask-how-body th { font-weight:500; color:var(--fg-3); }
    .secret-ask-by { margin:10px 0 0; font-size:var(--text-sm); color:var(--fg-3); }
    .secret-ask-elsewhere { margin:10px 0 0; font-size:var(--text-sm); color:var(--fg-3); }
  </style>
  <div class="secret-ask">
    ${notice ? `<p role="status">${text(notice)}</p>` : ""}
    <p class="secret-ask-reason" dir="auto">“${text(ask.reason)}”</p>
    <p class="secret-ask-asked">${text(words.asked(ask.task ? (taskTitle ?? ask.task) : null))}</p>
    ${how}
    <p class="secret-ask-elsewhere" data-inf-secret-elsewhere>${text(words.elsewhere)}</p>
  </div>`;
}
