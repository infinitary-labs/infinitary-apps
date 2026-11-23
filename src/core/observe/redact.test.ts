import { describe, expect, it } from "vitest";
import { redactDeep, redactObserveText } from "./redact";

describe("redactObserveText", () => {
  it("redacts GitLab access keys without swallowing adjacent prose", () => {
    expect(redactObserveText("before glpat-abc_123-def after")).toBe(
      "before [redacted token] after",
    );
    expect(redactDeep({ reply: "glpat-abc_123-def" })).toEqual({ reply: "[redacted token]" });
  });
  it("replaces provider keys and bearer tokens in place", () => {
    expect(redactObserveText("key sk-ant-api03-SECRETVALUE and done")).toBe(
      "key [redacted api key] and done",
    );
    expect(redactObserveText("Authorization: Bearer abc.def-ghi")).toBe("[redacted credential]");
    expect(redactObserveText("OPENAI_API_KEY=sk-proj-abcdefghij")).toContain("[redacted");
  });

  it("redacts complete RFC 6750 bearer tokens through both paths", () => {
    const assigned = redactObserveText("Authorization: Bearer abc~SECRET");
    expect(assigned).toBe("[redacted credential]");
    expect(assigned).not.toContain("abc");
    expect(assigned).not.toContain("SECRET");

    const token = "az.AZ_09+/-~TOKEN==";
    const standalone = redactObserveText(`before Bearer ${token} after`);
    expect(standalone).toBe("before Bearer [redacted] after");
    expect(standalone).not.toContain("az.AZ_09");
    expect(standalone).not.toContain("TOKEN");
    expect(standalone).not.toContain("==");
  });

  it("redacts complete sensitive headers without changing benign mentions", () => {
    const cookie = redactObserveText("Cookie: harmless=1; sessionid=PLANTEDSECRET; later=PAIR");
    expect(cookie).toBe("[redacted credential]");
    expect(cookie).not.toContain("PLANTEDSECRET");
    expect(cookie).not.toContain("later=PAIR");

    const setCookie = redactObserveText("Set-Cookie: a=1; token=PLANTEDSECRET; Path=/");
    expect(setCookie).toBe("[redacted credential]");
    expect(setCookie).not.toContain("PLANTEDSECRET");
    expect(setCookie).not.toContain("Path=/");

    expect(redactObserveText("Authorization: Bearer abc~SECRET")).toBe("[redacted credential]");
    expect(redactObserveText("before session=PLANTEDSECRET after")).toBe(
      "before [redacted credential] after",
    );
    expect(redactObserveText("This session explains cookie handling safely.")).toBe(
      "This session explains cookie handling safely.",
    );
  });

  it("redacts every supported credential assignment spelling", () => {
    const text = redactObserveText(
      "cookie=OPAQUECOOKIE session=OPAQUESESSION private key=OPAQUEONE " +
        "privatekey=OPAQUETWO private_key=OPAQUETHREE",
    );
    expect(text).not.toContain("OPAQUE");
    expect(text.match(/\[redacted credential\]/g)).toHaveLength(5);
  });

  it("redacts the shared credential-name vocabulary without substring matches", () => {
    const assigned = redactObserveText(
      "credential=PLANTED01 credentials=PLANTED02 passphrase=PLANTED03 " +
        "provider_auth=PLANTED04 authentication=PLANTED05 bearer=PLANTED06 " +
        "session_id=PLANTED07 csrf_token=PLANTED08 xsrf-token=PLANTED09 " +
        "secret_key=PLANTED10 access_key=PLANTED11 signing_key=PLANTED12 " +
        "connection_string=PLANTED13 dsn=PLANTED14 personal-access-token=PLANTED15 " +
        "github_pat=PLANTED16 oauth=PLANTED17 jwt=PLANTED18 ssh_key=PLANTED19 " +
        "encryption_key=PLANTED20 service_account_key=PLANTED21 recovery_code=PLANTED22 " +
        "otp=PLANTED23 totp=PLANTED24",
    );
    expect(assigned).not.toContain("PLANTED");
    expect(assigned.match(/\[redacted credential\]/g)).toHaveLength(24);

    const structured = redactDeep({
      credentials: "PLANTEDSTRUCTURED",
      nested: {
        passphrase: "PLANTEDPHRASE",
        provider_auth: "PLANTEDAUTH",
        oauth: "PLANTEDOAUTH",
      },
    });
    expect(JSON.stringify(structured)).not.toContain("PLANTED");
    expect(structured.credentials).toBe("[redacted credential]");

    const boundaries =
      "path=VISIBLE patch=VISIBLE author=VISIBLE authority=VISIBLE compat=VISIBLE oauthable=VISIBLE";
    expect(redactObserveText(boundaries)).toBe(boundaries);
    expect(
      redactDeep({
        path: "VISIBLE",
        patch: "VISIBLE",
        author: "VISIBLE",
        authority: "VISIBLE",
        oauthable: "VISIBLE",
      }),
    ).toEqual({
      path: "VISIBLE",
      patch: "VISIBLE",
      author: "VISIBLE",
      authority: "VISIBLE",
      oauthable: "VISIBLE",
    });

    const prose = "This author discusses auth, oauth, credentials, PAT, paths, and cookies safely.";
    expect(redactObserveText(prose)).toBe(prose);
  });

  it("redacts prefixed, dotted and escaped credential assignments", () => {
    const text = redactObserveText(
      String.raw`OPENAI_API_KEY=OPAQUEOPENAI client_secret=OPAQUECLIENT {"api.key":"OPAQUEJSON"} password="OPAQUE\" ESCAPED TAIL"`,
    );
    expect(text).not.toContain("OPAQUEOPENAI");
    expect(text).not.toContain("OPAQUECLIENT");
    expect(text).not.toContain("OPAQUEJSON");
    expect(text).not.toContain("OPAQUE");
    expect(text).not.toContain("ESCAPED TAIL");
    expect(text.match(/\[redacted credential\]/g)).toHaveLength(4);
  });

  it("redacts complete shell-quoted and escaped unquoted values", () => {
    const text = redactObserveText(
      String.raw`OPENAI_API_KEY=$'PLANTED ANSI SECRET' API_KEY=$"PLANTED LOCALE SECRET" API_KEY=foo\ bar API_KEY=$'PLANTED\' QUOTED TAIL'`,
    );
    expect(text).not.toContain("PLANTED");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("bar");
    expect(text).not.toContain("QUOTED TAIL");
    expect(text.match(/\[redacted credential\]/g)).toHaveLength(4);

    const boundaries = String.raw`path=foo\ bar author=$'VISIBLE VALUE'`;
    expect(redactObserveText(boundaries)).toBe(boundaries);
  });

  it("redacts complete escaped single-quoted values", () => {
    const text = redactObserveText(String.raw`passwd='OPAQUE\' SINGLE VALUE'`);
    expect(text).not.toContain("OPAQUE");
    expect(text).not.toContain("SINGLE VALUE");
    expect(text).toBe("[redacted credential]");
  });

  it("never returns a Firstmate or crewmate system prompt", () => {
    expect(
      redactObserveText("You are Firstmate 3000, the user's calm desktop first officer. Extra."),
    ).toBe("[system prompt redacted]");
    expect(
      redactObserveText("You are a crewmate: a background worker aboard Firstmate 3000."),
    ).toBe("[system prompt redacted]");
    expect(
      redactObserveText(
        "You are the first mate aboard Infinitary, the user's calm desktop first officer. Extra.",
      ),
    ).toBe("[system prompt redacted]");
    expect(
      redactObserveText(
        "You are a crewmate: a background worker aboard Infinitary, working for the first mate.",
      ),
    ).toBe("[system prompt redacted]");
  });
});

describe("redactDeep", () => {
  it("reaches a credential at any depth, in arrays, values and keys", () => {
    const redacted = redactDeep({
      args: {
        env: {
          OPENAI_API_KEY: "opaque-openai-value",
          access_token: "opaque-access-value",
          password: "hunter2",
          numeric_token: 7,
          cookie: false,
          secret: { nested: ["value"] },
          retries: 3,
        },
        headers: ["Bearer abc.def", { Authorization: "opaque-header-value" }],
      },
      evidence: [
        'answered with "password=hunter2hunter2"',
        String.raw`{"access.token":"OPAQUE\" NESTED VALUE"}`,
      ],
      counts: { ghp_abcdefghij: 3 },
      sibling: { token: "opaque-token-value", visible: "keep me" },
      at: 42,
      ok: true,
      nothing: null,
    });
    expect(JSON.stringify(redacted)).not.toContain("opaque-openai-value");
    expect(JSON.stringify(redacted)).not.toContain("opaque-access-value");
    expect(JSON.stringify(redacted)).not.toContain("opaque-header-value");
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
    expect(JSON.stringify(redacted)).not.toContain("OPAQUE NESTED VALUE");
    expect(JSON.stringify(redacted)).not.toContain("abc.def");
    expect(JSON.stringify(redacted)).not.toContain("ghp_abcdefghij");
    expect(redacted.args.env.numeric_token).toBe("[redacted credential]");
    expect(redacted.args.env.cookie).toBe("[redacted credential]");
    expect(redacted.args.env.secret).toBe("[redacted credential]");
    expect(redacted.args.env.retries).toBe(3);
    expect(redacted.sibling.visible).toBe("keep me");
    expect(Object.keys(redacted)).toEqual([
      "args",
      "evidence",
      "counts",
      "sibling",
      "at",
      "ok",
      "nothing",
    ]);
    expect(redacted.at).toBe(42);
    expect(redacted.ok).toBe(true);
    expect(redacted.nothing).toBeNull();
  });

  it("redacts every GitHub sign-in shape, the app's own OAuth sign-in included", () => {
    for (const token of ["gho_abc123XYZ", "ghu_abc123XYZ", "ghs_abc123XYZ", "ghr_abc123XYZ"]) {
      expect(redactObserveText(`signed in with ${token} here`)).toBe(
        "signed in with [redacted token] here",
      );
    }
  });

  it("is idempotent, so a record redacted twice is unchanged", () => {
    const once = redactDeep({ text: "key sk-ant-api03-SECRET and Bearer tok.en" });
    expect(redactDeep(once)).toEqual(once);
  });
});
