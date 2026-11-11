import { secretName } from "@shared/secretNames";
import {
  SECRET_APPROVAL_CARD_WORDS,
  SECRET_CHECKED_WORDS,
  type SecretsView,
} from "@shared/secrets";
import { escapeCardText } from "../orchestrator/cardText";
import type { BrokerFacts } from "./brokers";
import type { RecipientFacts } from "./recipient";

type Use = SecretsView["uses"][number];

/**
 * What the use will do, from its checked facts: a program run, or one request a
 * service adapter sends. `program` is the checked executable's path, never the
 * requester's own word for it.
 */
export type SecretRun =
  | { kind: "program"; program: string; argv: readonly string[]; cwd: string }
  | { kind: "service"; label: string; destination: string; operation: string };

/** Who asks and what runs, beside the use: the task's own title when a task asked. */
export type SecretAsk = { task: string | null; run: SecretRun };

/** The use's own secrets as prepared, then every other saved one, so the card names each as Settings does (`secretNames.secretName`). */
export type SecretIdentities = readonly { ref: string; label: string; environment: string }[];

/**
 * A program's run as a person reads it: the checked program's path, so a
 * look-alike script shows where it is, then its arguments as named, with a
 * file inside the working folder named from there.
 */
export function runWords(run: SecretRun): string {
  if (run.kind === "service") return `${run.label}: ${run.operation}`;
  const [, ...args] = run.argv;
  const folder = `${run.cwd.replace(/\/+$/, "")}/`;
  const shown = args.map((arg) => (arg.startsWith(folder) ? arg.slice(folder.length) : arg));
  return [run.program, ...shown].map(shellWord).join(" ");
}

/** One argument as a shell would read it back: bare when it needs no quotes. */
function shellWord(arg: string): string {
  return /^[^\s"'\\]+$/.test(arg) ? arg : JSON.stringify(arg);
}

/** How many of a fingerprint's characters a person reads; the whole one binds the run. */
const FINGERPRINT_SHOWN = 12;

/**
 * What was checked before the card, one line each (INF-1690's plan, piece 3):
 * the program, its interpreter and each file argument by real path, how each
 * is bound and its fingerprint; the arguments, the working folder, which
 * variable gets which secret, where output goes, and what is not checked.
 */
export function checkedFacts(
  facts: RecipientFacts,
  secrets: readonly { ref: string; label: string; environment?: string }[],
): { name: string; value: string }[] {
  const words = SECRET_CHECKED_WORDS;
  const print = (sha256: string) => `${words.fingerprint} ${sha256.slice(0, FINGERPRINT_SHOWN)}`;
  const bound = (file: { path: string; sha256: string; copied: boolean }) =>
    `${file.path} · ${file.copied ? words.copied : words.inPlace} · ${print(file.sha256)}`;
  const named = (ref: string) => {
    const secret = secrets.find((one) => one.ref === ref);
    if (!secret) return ref;
    return secret.environment ? `${secret.label} (${secret.environment})` : secret.label;
  };
  return [
    { name: words.program, value: bound(facts.executable) },
    ...(facts.interpreter
      ? [
          {
            name: words.interpreter,
            value: `${bound(facts.interpreter)}${facts.interpreter.arg ? ` · ${facts.interpreter.arg}` : ""}`,
          },
        ]
      : []),
    ...facts.inputs.map((input) => ({
      name: words.file,
      value: `${input.path} · ${words.input} · ${print(input.sha256)}`,
    })),
    { name: words.arguments, value: facts.argv.map(shellWord).join(" ") },
    { name: words.folder, value: facts.cwd },
    {
      name: words.secrets,
      value: Object.entries(facts.env)
        .map(([variable, ref]) => `${variable} ${words.gets} ${named(ref)}`)
        .join("; "),
    },
    { name: words.output, value: words.outputValue },
    { name: words.limit, value: words.limitValue },
  ];
}

/** What was checked for a service's request: where it goes, what it asks, and what comes back. */
export function brokerCheckedFacts(facts: BrokerFacts): { name: string; value: string }[] {
  const words = SECRET_CHECKED_WORDS;
  return [
    { name: words.destination, value: facts.destination },
    { name: words.operation, value: facts.operation },
    { name: words.result, value: facts.result },
    { name: words.read, value: facts.read ? words.readYes : words.readNo },
    {
      name: words.request,
      value: `${words.fingerprint} ${facts.inputDigest.slice(0, FINGERPRINT_SHOWN)}`,
    },
  ];
}

/**
 * App-authored presentation only (INF-1690's plan, piece 2): who asks, which
 * secrets, what runs and why, in the open; every checked fact one click
 * deeper. The controller still owns the exact offer and every approval, and
 * the same body reaches an enrolled phone, so it names no device.
 */
export function secretApprovalBody(
  use: Use,
  ask: SecretAsk,
  identities: SecretIdentities,
  notice?: string,
): string {
  const text = escapeCardText;
  const words = SECRET_APPROVAL_CARD_WORDS;
  const run = ask.run;
  const what =
    run.kind === "program"
      ? `${words.runs} <code>${text(runWords(run))}</code> ${words.in} <code>${text(run.cwd)}</code>.`
      : `${words.sends} <code>${text(run.destination)}</code>: ${text(run.operation)}.`;
  const named = (detail: boolean) =>
    `<ul aria-label="${detail ? "Secrets as checked" : "Secrets requested"}">${use.secrets
      .map(
        (secret) =>
          `<li data-secret-ref="${text(secret.ref)}">${text(secretName(identities, secret.ref))}${detail ? ` · <code>${text(secret.ref)}</code> · version ${secret.version}` : ""}</li>`,
      )
      .join("")}</ul>`;
  // The title names one or two secrets; more are listed here.
  const many = use.secrets.length > 2;
  const facts = use.facts
    .map(
      // Each check reads as words; a path inside one wraps anywhere.
      (fact) => `<div><dt>${text(fact.name)}</dt><dd>${text(fact.value)}</dd></div>`,
    )
    .join("");
  return `<style>
    .secret-request p { margin:0 0 var(--space-2); }
    .secret-request-lead { color:var(--fg-1); }
    .secret-request-scope { margin-top:var(--space-3); color:var(--fg-2); }
    .secret-request code { white-space:pre-wrap; overflow-wrap:anywhere; }
    .secret-request ul { margin:var(--space-2) 0 0; padding-left:var(--space-4); }
    .secret-request dl { margin:var(--space-2) 0 0; max-width:none; }
    .secret-request dl > div { display:grid; grid-template-columns:8rem minmax(0,1fr); gap:var(--space-2); margin-top:var(--space-2); }
    .secret-request dt { color:var(--fg-3); }
    .secret-request dd { margin:0; overflow-wrap:anywhere; }
    .secret-request-confirm { margin-top:var(--space-3); color:var(--fg-3); }
    @media (max-width:480px) { .secret-request dl > div { grid-template-columns:minmax(0,1fr); gap:var(--space-1); } }
  </style>
  <div class="secret-request">
    ${notice ? `<p role="status">${text(notice)}</p>` : ""}
    <section class="secret-request-lead" aria-label="The request">
      <p>${text(words.asked(ask.task))}</p>
      <p>${what}</p>
      ${many ? named(false) : ""}
      <p>${text(words.reason)} “${text(use.reason)}”</p>
    </section>
    <section class="secret-request-scope" aria-label="What allowing covers">
      <p>${text(words.scope)}</p>
      <p>${text(use.shortReadEligible ? words.read : words.always)}</p>
    </section>
    <details><summary>${text(words.checked)}</summary>
      ${named(true)}
      <dl>${facts}</dl>
    </details>
    <p class="secret-request-confirm">${text(words.confirm)}</p>
  </div>`;
}
