import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import {
  SECRET_APPROVAL_CARD_WORDS,
  SECRET_CHECKED_WORDS,
  SECRETS_WORDS,
  type SecretsView,
} from "../../shared/secrets";
import { runWords, type SecretAsk, secretApprovalBody } from "./approvalCard";

// Intent: INF-1690's accepted plan (the captain's direction B), piece 2: the
// approval card "names the key and the task, says who asks, what runs and
// why", with everything checked one click deeper. INF-1109's revision still
// holds: two secrets of one name stay apart, and checked facts stay reachable.
// INF-4087's accepted plan (the captain's answers): labelled rows, the task's
// name in quotes, the command in single quotes, "Not checked" still folded,
// and one line per allow button saying what it covers.
const request: SecretsView["uses"][number] = {
  request: "website-credential-check",
  state: "waiting",
  reason: "Compare the website deployment credentials",
  recipient: "/bin/sh",
  secrets: [
    { ref: "website-staging", label: "Website deployment", version: 1, environment: "Staging" },
    {
      ref: "website-production",
      label: "Website deployment",
      version: 2,
      environment: "Production",
    },
  ],
  facts: [
    { name: "Program", value: "/bin/sh" },
    { name: "Arguments", value: '["/bin/sh","/workspace/website/check-website.sh","--both"]' },
    { name: "Working folder", value: "/workspace/website" },
    {
      name: "Secrets go in as",
      value:
        "STAGING_TOKEN gets Website deployment (Staging); PRODUCTION_TOKEN gets Website deployment (Production)",
    },
    { name: SECRET_CHECKED_WORDS.limit, value: SECRET_CHECKED_WORDS.limitValue },
  ],
  shortReadEligible: false,
  expires: 300_000,
};
const ask: SecretAsk = {
  task: "Deploy the site",
  run: {
    kind: "program",
    program: "/workspace/website/sh",
    argv: ["./sh", "/workspace/website/check-website.sh", "--both"],
    cwd: "/workspace/website",
    env: { STAGING_TOKEN: "website-staging", PRODUCTION_TOKEN: "website-production" },
  },
};

function region(body: string, label: string) {
  const found = DomUtils.findOne(
    (node) => node.attribs["aria-label"] === label,
    parseDocument(body).children,
    true,
  );
  if (!found) throw new Error(`Missing approval region: ${label}`);
  return found;
}
/** A labelled list's rows as [label, value] text, in order. */
function rows(body: string, label: string): [string, string][] {
  return DomUtils.getElementsByTagName("div", region(body, label), true).map((row) => [
    DomUtils.textContent(DomUtils.getElementsByTagName("dt", row, true)),
    DomUtils.textContent(DomUtils.getElementsByTagName("dd", row, true)),
  ]);
}
function outsideDetails(body: string): string {
  const document = parseDocument(body);
  for (const details of DomUtils.getElementsByTagName("details", document, true))
    DomUtils.removeElement(details);
  for (const style of DomUtils.getElementsByTagName("style", document, true))
    DomUtils.removeElement(style);
  return DomUtils.textContent(document);
}

describe("the approval card that asks the person's question", () => {
  it("says which secrets go in as what, what runs where, and why, one row each", () => {
    const body = secretApprovalBody(request, ask, request.secrets);
    const words = SECRET_APPROVAL_CARD_WORDS;
    const open = rows(body, "The request");
    expect(open.map(([label]) => label)).toEqual([
      words.secrets,
      words.runs,
      words.in,
      words.reason,
    ]);
    const named = region(body, "Secrets requested");
    expect(DomUtils.getElementsByTagName("li", named, true).map(DomUtils.textContent)).toEqual([
      `Website deployment (Staging) ${words.goesIn} STAGING_TOKEN`,
      `Website deployment (Production) ${words.goesIn} PRODUCTION_TOKEN`,
    ]);
    // The captain's review answer: "The program's checked location, so a
    // look-alike script is visible", never the requester's own word for it.
    expect(open[1]?.[1]).toBe("/workspace/website/sh check-website.sh --both");
    expect(open[2]?.[1]).toBe("/workspace/website");
    expect(open[3]?.[1]).toBe(`“${request.reason}”${words.asked("Deploy the site")}`);
    // The title names the task, so the open body does not repeat it.
    expect(outsideDetails(body)).not.toContain("Deploy the site");
    expect(words.title("the Website deployment secret", ask.task)).toBe(
      "Give the Website deployment secret to “Deploy the site”?",
    );
    expect(words.title("the Website deployment secret", null)).toBe(
      "Give the Website deployment secret to Infinitary?",
    );
  });

  it("shows a command the way a shell reads it, in single quotes without backslashes", () => {
    const run = (argv: string[]) =>
      runWords({ kind: "program", program: "/bin/sh", argv: ["sh", ...argv], cwd: "/workspace" });
    // The command in the captain's screenshot.
    expect(run(["-c", 'test -n "$TEST_KEY" && echo set'])).toBe(
      `/bin/sh -c 'test -n "$TEST_KEY" && echo set'`,
    );
    expect(run(["-c", "echo it's set"])).toBe(String.raw`/bin/sh -c 'echo it'\''s set'`);
    expect(run(["/workspace/deploy.sh", "--staging", ""])).toBe("/bin/sh deploy.sh --staging ''");
  });

  it("keeps references, versions and every checked fact one click deeper", () => {
    const body = secretApprovalBody(request, ask, request.secrets);
    const open = outsideDetails(body);
    for (const secret of request.secrets) expect(open).not.toContain(secret.ref);
    expect(open).not.toContain("version");
    const details = DomUtils.getElementsByTagName("details", parseDocument(body), true);
    expect(details).toHaveLength(1);
    const deeper = DomUtils.textContent(details);
    expect(deeper).toContain(SECRET_APPROVAL_CARD_WORDS.checked);
    for (const secret of request.secrets) {
      expect(deeper).toContain(`Website deployment (${secret.environment})`);
      expect(deeper).toContain(`${secret.ref} · version ${secret.version}`);
    }
    for (const fact of request.facts) expect(deeper).toContain(fact.value);
    // The captain's answer 4: what was not checked stays in the folded list.
    expect(open).not.toContain(SECRET_CHECKED_WORDS.limitValue);
  });

  it("names Infinitary when no task asked, and lists every secret in the open", () => {
    const three = {
      ...request,
      secrets: [
        ...request.secrets,
        { ref: "billing-read", label: "Customer billing", version: 1, environment: "" },
      ],
    };
    const body = secretApprovalBody(three, { ...ask, task: null }, three.secrets);
    expect(outsideDetails(body)).toContain(SECRET_APPROVAL_CARD_WORDS.asked(null));
    const listed = region(body, "Secrets requested");
    const names = DomUtils.findAll((node) => "data-secret-name" in node.attribs, [listed]);
    expect(names.map(DomUtils.textContent)).toEqual([
      "Website deployment (Staging)",
      "Website deployment (Production)",
      "Customer billing",
    ]);
  });

  it("renders names and explanations as text rather than executable markup", () => {
    const name = "Billing <test> & reports";
    const reason = '<img src="outside.invalid" onerror="throw 1">';
    const environment = "<production> & preview";
    const secret = request.secrets[0];
    if (!secret) throw new Error("No requested-secret fixture.");
    // Two of one name, so each is named with its place.
    const secrets = [
      { ...secret, label: name, environment },
      { ...secret, ref: "billing-other", label: name, environment: "Other" },
    ];
    const body = secretApprovalBody(
      { ...request, reason, secrets },
      { ...ask, task: "<em>Deploy</em>" },
      secrets,
    );
    const document = parseDocument(body);
    for (const tag of ["img", "test", "production", "em"])
      expect(DomUtils.getElementsByTagName(tag, document, true)).toEqual([]);
    expect(DomUtils.textContent(document)).toContain(name);
    expect(DomUtils.textContent(document)).toContain(environment);
    expect(DomUtils.textContent(document)).toContain(reason);
  });

  it("says beside each allow button what it covers, and the read's ten minutes only for an eligible read", () => {
    const words = SECRET_APPROVAL_CARD_WORDS;
    const service: SecretAsk = {
      task: "Plan next week's meetings",
      run: {
        kind: "service",
        label: "Planning calendar",
        destination: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        operation: "Read planning meetings",
      },
    };
    const calendar = request.secrets.slice(0, 1);
    const read = {
      ...request,
      recipient: "Planning calendar",
      secrets: calendar,
      shortReadEligible: true,
    };
    const readBody = secretApprovalBody(read, service, read.secrets);
    expect(rows(readBody, "The request").map(([label]) => label)).toEqual([
      words.secret,
      words.sends,
      words.request,
      words.reason,
    ]);
    expect(outsideDetails(readBody)).toContain(
      service.run.kind === "service" ? service.run.destination : "",
    );
    expect(rows(readBody, "What allowing covers")).toEqual([
      [SECRETS_WORDS.once, words.once(false)],
      [SECRETS_WORDS.short, words.read],
    ]);
    expect(outsideDetails(readBody)).toContain(words.keep(false));
    const program = secretApprovalBody(request, ask, request.secrets);
    expect(rows(program, "What allowing covers")).toEqual([
      [SECRETS_WORDS.once, words.once(true)],
      [SECRETS_WORDS.always, words.always],
    ]);
    const text = outsideDetails(program);
    expect(text).not.toContain(SECRETS_WORDS.short);
    expect(text).toContain(`${words.keep(true)} ${words.never} ${words.confirm}`);
    // The same body reaches an enrolled phone, so it names no device.
    expect(text).not.toMatch(/Your (computer|Mac) asks/);
    expect(runWords(service.run)).toBe("Planning calendar: Read planning meetings");
  });

  it("keeps a failed confirmation's status as the body's first line", () => {
    const notice = "No confirmation was accepted. This request is still waiting.";
    const body = secretApprovalBody(request, ask, request.secrets, notice);
    const first = DomUtils.findOne(
      (node) => node.name === "p" || node.name === "dl",
      parseDocument(body).children,
      true,
    );
    expect(first?.attribs.role).toBe("status");
    expect(first && DomUtils.textContent(first)).toBe(notice);
  });
});
