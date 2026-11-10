import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { SECRETS_WORDS, type SecretsView } from "../../shared/secrets";
import { secretApprovalBody } from "./approvalCard";
import { SHORT_READ_SECONDS, SHORT_READ_USES } from "./readAccess";

// Intent: the captain's INF-1109 UX revision requires identifiable requested
// secrets, not generic boxes, while checked facts and approval scope stay clear.
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
    { name: "Arguments", value: '["/bin/sh","check-website.sh"]' },
    { name: "Working folder", value: "/workspace/website" },
    { name: "Delivery", value: "STAGING_TOKEN, PRODUCTION_TOKEN" },
  ],
  shortReadEligible: false,
  expires: 300_000,
};

function region(body: string, label: string) {
  const document = parseDocument(body);
  const found = DomUtils.findOne(
    (node) => node.attribs["aria-label"] === label,
    document.children,
    true,
  );
  if (!found) throw new Error(`Missing approval region: ${label}`);
  return found;
}

describe("the named-secret approval presentation", () => {
  it("gives each requested secret a visible row and distinguishes duplicate names", () => {
    const secrets = region(secretApprovalBody(request, true), "Secrets requested");
    const rows = DomUtils.getElementsByTagName("li", secrets, true);
    expect(rows).toHaveLength(request.secrets.length);
    for (const [index, row] of rows.entries()) {
      const secret = request.secrets[index];
      if (!secret) throw new Error("Unexpected requested-secret row.");
      expect(DomUtils.textContent(DomUtils.getElementsByTagName("strong", row, true))).toBe(
        secret.label,
      );
      expect(DomUtils.textContent(row)).toContain(secret.ref);
      expect(DomUtils.textContent(row)).toContain(secret.environment);
      expect(DomUtils.textContent(row)).toContain(`Saved version ${secret.version}`);
    }
    expect(DomUtils.getElementsByTagName("details", secrets, true)).toEqual([]);
  });

  it("keeps the checked recipient and operation in the open, apart from the stated reason", () => {
    const body = secretApprovalBody(request, true);
    const receiver = region(body, "Who receives the values");
    const words = DomUtils.textContent(receiver);
    expect(words).toContain(request.recipient);
    for (const fact of request.facts.slice(0, 2)) expect(words).toContain(fact.value);
    expect(words).toContain(`Requested reason: ${request.reason}`);
    expect(DomUtils.getElementsByTagName("details", receiver, true)).toEqual([]);
    const details = DomUtils.getElementsByTagName("details", parseDocument(body), true);
    expect(details).toHaveLength(1);
    for (const fact of request.facts.slice(2))
      expect(DomUtils.textContent(details)).toContain(fact.value);
  });

  it("renders names and explanations as text rather than executable markup", () => {
    const name = "Billing <test> & reports";
    const reason = '<img src="outside.invalid" onerror="throw 1">';
    const environment = "<production> & preview";
    const secret = request.secrets[0];
    if (!secret) throw new Error("No requested-secret fixture.");
    const body = secretApprovalBody(
      { ...request, reason, secrets: [{ ...secret, label: name, environment }] },
      true,
    );
    const document = parseDocument(body);
    expect(DomUtils.getElementsByTagName("img", document, true)).toEqual([]);
    expect(DomUtils.getElementsByTagName("test", document, true)).toEqual([]);
    expect(DomUtils.getElementsByTagName("production", document, true)).toEqual([]);
    expect(DomUtils.textContent(document)).toContain(name);
    expect(DomUtils.textContent(document)).toContain(environment);
    expect(DomUtils.textContent(document)).toContain(reason);
  });

  it("explains only an eligible read's existing temporary permission", () => {
    const read = { ...request, recipient: "Website status service", shortReadEligible: true };
    const text = DomUtils.textContent(parseDocument(secretApprovalBody(read, false)));
    expect(text).toContain(`${SHORT_READ_SECONDS / 60} minutes or ${SHORT_READ_USES} uses`);
    expect(text).toContain("End access in Secrets stops future reads.");
    // The same body reaches the enrolled phone, whose footer offers only one use.
    expect(text).toContain("Temporary access is available only on your computer.");
    expect(text).toContain("Allow once shares these values for this use only, after you confirm.");
    expect(DomUtils.textContent(parseDocument(secretApprovalBody(request, true)))).not.toContain(
      SECRETS_WORDS.short,
    );
  });
});
