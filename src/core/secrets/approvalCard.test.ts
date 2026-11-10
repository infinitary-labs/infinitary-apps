import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { SECRET_APPROVAL_CARD_WORDS, SECRETS_WORDS, type SecretsView } from "../../shared/secrets";
import { runWords, type SecretAsk, secretApprovalBody } from "./approvalCard";

// Intent: INF-1690's accepted plan (the captain's direction B), piece 2: the
// approval card "names the key and the task, says who asks, what runs and
// why", with everything checked one click deeper. INF-1109's revision still
// holds: two secrets of one name stay apart, and checked facts stay reachable.
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
    { name: "Variable mapping", value: '{"STAGING_TOKEN":"website-staging"}' },
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
function outsideDetails(body: string): string {
  const document = parseDocument(body);
  for (const details of DomUtils.getElementsByTagName("details", document, true))
    DomUtils.removeElement(details);
  for (const style of DomUtils.getElementsByTagName("style", document, true))
    DomUtils.removeElement(style);
  return DomUtils.textContent(document);
}

describe("the approval card that asks the person's question", () => {
  it("says who asks, what runs and why in the open", () => {
    const body = secretApprovalBody(request, ask, request.secrets);
    const words = DomUtils.textContent(region(body, "The request"));
    expect(words).toContain(SECRET_APPROVAL_CARD_WORDS.asked("Deploy the site"));
    // The captain's review answer: "The program's checked location, so a
    // look-alike script is visible", never the requester's own word for it.
    expect(words).toContain("/workspace/website/sh check-website.sh --both");
    expect(words).toContain("/workspace/website");
    expect(words).toContain(`“${request.reason}”`);
    expect(SECRET_APPROVAL_CARD_WORDS.title("the Website deployment secret", ask.task)).toBe(
      "Give the Website deployment secret to Deploy the site?",
    );
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
  });

  it("names Infinitary when no task asked, and lists more than two secrets in the open", () => {
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
    expect(DomUtils.getElementsByTagName("li", listed, true).map(DomUtils.textContent)).toEqual([
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
      { ...ask, task: "<b>Deploy</b>" },
      secrets,
    );
    const document = parseDocument(body);
    for (const tag of ["img", "test", "production", "b"])
      expect(DomUtils.getElementsByTagName(tag, document, true)).toEqual([]);
    expect(DomUtils.textContent(document)).toContain(name);
    expect(DomUtils.textContent(document)).toContain(environment);
    expect(DomUtils.textContent(document)).toContain(reason);
  });

  it("explains the read's ten minutes only for an eligible read, and names no device", () => {
    const service: SecretAsk = {
      task: "Plan next week's meetings",
      run: {
        kind: "service",
        label: "Planning calendar",
        destination: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        operation: "Read planning meetings",
      },
    };
    const read = { ...request, recipient: "Planning calendar", shortReadEligible: true };
    const text = outsideDetails(secretApprovalBody(read, service, read.secrets));
    expect(text).toContain(SECRET_APPROVAL_CARD_WORDS.read);
    expect(text).toContain(service.run.kind === "service" ? service.run.destination : "");
    expect(text).not.toContain(SECRET_APPROVAL_CARD_WORDS.always);
    const program = outsideDetails(secretApprovalBody(request, ask, request.secrets));
    expect(program).toContain(SECRET_APPROVAL_CARD_WORDS.always);
    expect(program).not.toContain(SECRETS_WORDS.short);
    // The same body reaches an enrolled phone, so it names no device.
    expect(program).toContain(SECRET_APPROVAL_CARD_WORDS.confirm);
    expect(program).not.toMatch(/Your (computer|Mac) asks/);
    expect(runWords(service.run)).toBe("Planning calendar: Read planning meetings");
  });
});
