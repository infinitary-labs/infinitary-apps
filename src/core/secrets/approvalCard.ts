import { secretName } from "@shared/secretNames";
import {
  SECRET_APPROVAL_CARD_WORDS,
  SECRET_CHECKED_WORDS,
  SECRETS_WORDS,
  type SecretsView,
} from "@shared/secrets";
import { escapeCardText } from "../orchestrator/cardText";
import type { BrokerFacts } from "./brokers";
import type { RecipientFacts } from "./recipient";

type Use = SecretsView["uses"][number];

/**
 * What the use will do, from its checked facts: a program run, or one request a
 * service adapter sends. `program` is the checked executable's path, never the
 * requester's own word for it; `env` is the checked variable each secret goes
 * in as, by reference.
 */
export type SecretRun =
  | (ProgramRun & { env: Readonly<Record<string, string>> })
  | { kind: "service"; label: string; destination: string; operation: string };

/** A program's run as `runWords` names it; which variable gets which secret is not part of its words. */
type ProgramRun = { kind: "program"; program: string; argv: readonly string[]; cwd: string };

/** Who asks and what runs, beside the use: the task's own title when a task asked. */
export type SecretAsk = { task: string | null; run: SecretRun };

/** The use's own secrets as prepared, then every other saved one, so the card names each as Settings does (`secretNames.secretName`). */
export type SecretIdentities = readonly { ref: string; label: string; environment: string }[];

/**
 * A program's run as a person reads it: the checked program's path, so a
 * look-alike script shows where it is, then its arguments as named, with a
 * file inside the working folder named from there.
 */
export function runWords(run: ProgramRun | Exclude<SecretRun, ProgramRun>): string {
  if (run.kind === "service") return `${run.label}: ${run.operation}`;
  const [, ...args] = run.argv;
  const folder = `${run.cwd.replace(/\/+$/, "")}/`;
  const shown = args.map((arg) => (arg.startsWith(folder) ? arg.slice(folder.length) : arg));
  return [run.program, ...shown].map(shellWord).join(" ");
}

/**
 * One argument as a shell would read it back: bare when it needs no quotes,
 * otherwise in single quotes, which keep every character as it is, with an
 * inner single quote written '\''.
 */
function shellWord(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
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
 * App-authored presentation only (INF-1690's plan, piece 2; INF-4087's rows):
 * one labelled row per fact - each secret and the variable it goes in as,
 * what runs and where or what is sent and to whom, and the reason in quotes
 * with who wrote it - then every checked fact one click deeper, then one line
 * per allow button saying what it covers. The controller still owns the exact
 * offer and every approval, and the same body reaches an enrolled phone, so
 * it names no device.
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
  const many = use.secrets.length > 1;
  const row = (name: string, value: string, quiet = false) =>
    `<div><dt>${text(name)}</dt><dd${quiet ? ' class="secret-request-quiet"' : ""}>${value}</dd></div>`;
  const variables = (ref: string) =>
    run.kind === "program"
      ? Object.entries(run.env)
          .filter(([, one]) => one === ref)
          .map(([variable]) => `<code>${text(variable)}</code>`)
      : [];
  const secrets = `<ul aria-label="Secrets requested">${use.secrets
    .map((secret) => {
      const as = variables(secret.ref);
      return `<li data-secret-ref="${text(secret.ref)}"><b data-secret-name>${text(secretName(identities, secret.ref))}</b>${as.length ? ` <span class="secret-request-as">${text(words.goesIn)} ${as.join(", ")}</span>` : ""}</li>`;
    })
    .join("")}</ul>`;
  const what =
    run.kind === "program"
      ? row(words.runs, `<code class="secret-request-cmd">${text(runWords(run))}</code>`) +
        row(words.in, `<code>${text(run.cwd)}</code>`)
      : row(words.sends, `<code class="secret-request-cmd">${text(run.destination)}</code>`) +
        row(words.request, text(run.operation));
  const checked = [
    ...use.secrets.map((secret) =>
      row(
        SECRET_CHECKED_WORDS.secret,
        `${text(secretName(identities, secret.ref))} · <code>${text(secret.ref)}</code> · version ${secret.version}`,
      ),
    ),
    // Each check reads as words; a path inside one wraps anywhere.
    ...use.facts.map((fact) => row(fact.name, text(fact.value))),
  ].join("");
  const second = use.shortReadEligible
    ? row(SECRETS_WORDS.short, text(words.read))
    : row(SECRETS_WORDS.always, text(words.always));
  return `<style>
    .secret-request { max-width:44rem; color:var(--fg-2); }
    .secret-request :is(p, dl, ul, summary) { max-width:none; }
    .secret-request [role="status"] { margin:0 0 var(--space-3); color:var(--fg-1); }
    .secret-request dl { display:grid; row-gap:10px; margin:0; }
    .secret-request dl > div { display:grid; grid-template-columns:8.5rem minmax(0,1fr); column-gap:var(--space-4); align-items:baseline; }
    .secret-request dt { font-size:var(--text-sm); color:var(--fg-3); }
    .secret-request dd { margin:0; min-width:0; color:var(--fg-1); overflow-wrap:anywhere; }
    .secret-request dd.secret-request-quiet { color:var(--fg-2); }
    .secret-request b { font-weight:500; color:var(--fg-1); }
    .secret-request small { display:block; margin-top:2px; font-size:var(--text-sm); color:var(--fg-3); }
    .secret-request code { font-family:var(--font-mono); font-size:var(--text-sm); color:var(--fg-1); white-space:pre-wrap; overflow-wrap:anywhere; }
    .secret-request ul { list-style:none; margin:0; padding:0; display:grid; row-gap:4px; }
    .secret-request li { margin:0; }
    .secret-request-as { margin-left:6px; color:var(--fg-3); }
    .secret-request-cmd { display:block; padding:7px 10px; background:var(--bg-0); border:1px solid var(--line-1); border-radius:var(--radius-s); line-height:1.5; }
    .secret-request details { margin:var(--space-3) 0 0; padding:0; border:0; border-radius:0; }
    .secret-request summary { font-size:var(--text-sm); font-weight:400; color:var(--fg-2); }
    .secret-request details[open] > summary { margin-bottom:10px; }
    .secret-request-deep { row-gap:8px; }
    .secret-request-deep dd { font-size:var(--text-sm); color:var(--fg-2); }
    .secret-request-deep code { color:var(--fg-2); }
    .secret-request-allows { row-gap:8px; margin:14px 0 0; padding-top:14px; border-top:1px solid var(--line-1); }
    .secret-request-allows dt { font-size:var(--text-base); font-weight:500; color:var(--fg-1); }
    .secret-request-allows dd { color:var(--fg-2); }
    .secret-request-fine { margin:10px 0 0; font-size:var(--text-sm); color:var(--fg-3); }
    @media (max-width:480px) {
      .secret-request dl > div { grid-template-columns:minmax(0,1fr); row-gap:2px; }
      .secret-request-as { display:block; margin-left:0; }
    }
  </style>
  <div class="secret-request">
    ${notice ? `<p role="status">${text(notice)}</p>` : ""}
    <dl aria-label="The request">
      ${row(many ? words.secrets : words.secret, secrets)}
      ${what}
      ${row(words.reason, `“${text(use.reason)}”<small>${text(words.asked(ask.task))}</small>`, true)}
    </dl>
    <details><summary>${text(words.checked)}</summary>
      <dl class="secret-request-deep" aria-label="Secrets as checked">${checked}</dl>
    </details>
    <dl class="secret-request-allows" aria-label="What allowing covers">
      ${row(SECRETS_WORDS.once, text(words.once(many)))}
      ${second}
    </dl>
    <p class="secret-request-fine">${text(`${words.keep(many)} ${words.never} ${words.confirm}`)}</p>
  </div>`;
}
