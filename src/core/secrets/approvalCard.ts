import { SECRET_OVERVIEW_FACTS, SECRETS_WORDS, type SecretsView } from "@shared/secrets";
import { escapeCardText } from "../orchestrator/cardText";
import { SHORT_READ_SECONDS, SHORT_READ_USES } from "./readAccess";

type Use = SecretsView["uses"][number];

/** App-authored presentation only. The controller still owns the exact offer and every approval. */
export function secretApprovalBody(use: Use, program: boolean, notice?: string): string {
  const text = escapeCardText;
  const secrets = use.secrets
    .map(
      (secret) => `<li class="secret-request-entry" data-secret-ref="${text(secret.ref)}">
        <strong>${text(secret.label)}</strong>
        ${secret.environment ? `<span class="secret-request-environment">${text(secret.environment)}</span>` : ""}
        <span class="secret-request-identity"><code>${text(secret.ref)}</code><span>Saved version ${secret.version}</span></span>
      </li>`,
    )
    .join("");
  const facts = (rows: Use["facts"]) =>
    rows
      .map(
        (fact) => `<div><dt>${text(fact.name)}</dt><dd><code>${text(fact.value)}</code></dd></div>`,
      )
      .join("");
  return `<style>
    .secret-request section { margin-block:var(--space-4); }
    .secret-request h3 { margin:0 0 var(--space-2); }
    .secret-request ul { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr)); gap:var(--space-2); list-style:none; padding:0; margin:0; max-width:none; }
    .secret-request-entry { margin:0; padding:var(--space-2) var(--space-3); border:1px solid var(--line-1); border-radius:var(--radius-s); background:var(--bg-1); }
    .secret-request-entry strong { display:block; font-size:var(--text-md); color:var(--fg-1); overflow-wrap:anywhere; }
    .secret-request-environment { display:block; margin-top:var(--space-1); color:var(--fg-2); overflow-wrap:anywhere; }
    .secret-request-identity { display:flex; flex-wrap:wrap; gap:var(--space-2) var(--space-4); margin-top:var(--space-1); color:var(--fg-3); font-size:var(--text-sm); }
    .secret-request-identity code { color:var(--fg-2); }
    .secret-request dl { margin:var(--space-3) 0 0; max-width:none; }
    .secret-request dl > div { display:grid; grid-template-columns:8rem minmax(0,1fr); gap:var(--space-2); margin-top:var(--space-2); }
    .secret-request dt { color:var(--fg-3); }
    .secret-request dd { margin:0; }
    .secret-request code { white-space:pre-wrap; overflow-wrap:anywhere; }
    .secret-request-recipient { margin:0; color:var(--fg-1); }
    .secret-request-reason { margin:var(--space-3) 0 0; color:var(--fg-3); }
    .secret-request-scope { border-top:1px solid var(--line-1); padding-top:var(--space-3); }
    .secret-request-scope p { margin:0 0 var(--space-2); }
    @media (max-width:480px) { .secret-request dl > div { grid-template-columns:minmax(0,1fr); gap:var(--space-1); } }
  </style>
  <div class="secret-request">
    ${notice ? `<p role="status">${text(notice)}</p>` : ""}
    <section aria-label="Secrets requested">
      <h3>Secrets requested</h3>
      <ul>${secrets}</ul>
    </section>
    <section aria-label="Who receives the values">
      <h3>${program ? "Program receiving the values" : "Service receiving the values"}</h3>
      <p class="secret-request-recipient"><${program ? "code" : "strong"}>${text(use.recipient)}</${program ? "code" : "strong"}></p>
      <dl>${facts(use.facts.filter((fact) => SECRET_OVERVIEW_FACTS.includes(fact.name)))}</dl>
      <p class="secret-request-reason">Requested reason: ${text(use.reason)}</p>
    </section>
    <div class="secret-request-scope">
      <p>Allow once shares these values for this use only, after you confirm.</p>
      ${use.shortReadEligible ? `<p>Temporary access is available only on your computer. “${text(SECRETS_WORDS.short)}” repeats only this exact read, for up to ${SHORT_READ_SECONDS / 60} minutes or ${SHORT_READ_USES} uses. End access in Secrets stops future reads.</p>` : ""}
      <p>The recipient can keep the values. This does not approve any separate action, such as deploying or sending something.</p>
      ${program ? "<p>Other files this program loads and programs it starts are not isolated.</p>" : ""}
    </div>
    <details><summary>Checked files and delivery</summary><dl>${facts(use.facts)}</dl></details>
  </div>`;
}
