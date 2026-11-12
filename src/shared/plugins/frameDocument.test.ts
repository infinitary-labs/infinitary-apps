import { describe, expect, it } from "vitest";
import { setCurrentLanguage } from "../i18n/current";
import { FRAME_CSP } from "./containment";
import {
  buildFrameDocument,
  buildPanelDocument,
  cardFrameMountRequestSchema,
  frameMountRequestSchema,
  frameTemplateSchema,
  scriptSafeJson,
} from "./frameDocument";
import { FRAME_BRIDGE_SCRIPT } from "./frameScript";

describe("the frame document", () => {
  it("assembles head, bridge, markup, and an optional template script in order", () => {
    const document = buildFrameDocument({
      csp: FRAME_CSP,
      theme: "light",
      title: 'Observe "dev"',
      style: "body { color: red; }",
      html: "<main>hi</main>",
      script: "console.log(1);",
    });
    const order = [
      "<!doctype html>",
      '<html lang="en" dir="ltr" data-theme="light">',
      '<meta http-equiv="Content-Security-Policy" content="',
      '<meta charset="utf-8">',
      "<title>Observe &quot;dev&quot;</title>",
      "<style>body { color: red; }</style>",
      `<script>${FRAME_BRIDGE_SCRIPT}</script>`,
      '<body data-theme="light">',
      "<main>hi</main>",
      "<script>console.log(1);</script>",
      "</body>",
    ];
    let cursor = -1;
    for (const part of order) {
      const at = document.indexOf(part, cursor + 1);
      expect(at, part).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(document).toContain(`content="${FRAME_CSP.replaceAll('"', "&quot;")}"`);
  });

  it("marks a card's page held, and no other document (FI3-871)", () => {
    const parts = { csp: FRAME_CSP, theme: "dark" as const, style: "", html: "<p>x</p>" };
    expect(buildFrameDocument({ ...parts, held: true })).toContain(
      '<html lang="en" dir="ltr" data-theme="dark" data-inf-held>',
    );
    expect(buildFrameDocument(parts)).toContain('<html lang="en" dir="ltr" data-theme="dark">');
    expect(buildFrameDocument(parts)).not.toMatch(/<html[^>]*data-inf-held/);
  });

  // INF-3674's approved plan: a right-to-left language ships in the first round, so a frame runs the way the window does.
  it("is born speaking the window's language, running right to left in a right-to-left one", () => {
    const parts = { csp: FRAME_CSP, theme: "dark" as const, style: "", html: "<p>x</p>" };
    expect(buildFrameDocument({ ...parts, language: "ar-XB" })).toContain(
      '<html lang="ar-XB" dir="rtl"',
    );
    setCurrentLanguage("ar-XB");
    try {
      expect(buildFrameDocument(parts)).toContain('<html lang="ar-XB" dir="rtl"');
      expect(
        buildPanelDocument({
          ...parts,
          title: "Now",
          importMap: "{}",
          config: { module: "x" } as never,
          bootIntegrity: "sha384-x",
        }),
      ).toContain('<html lang="ar-XB" dir="rtl"');
    } finally {
      setCurrentLanguage("en");
    }
  });

  it("refuses a template whose text would close its own element early", () => {
    expect(frameTemplateSchema.safeParse({ html: "<p>ok</p>" }).success).toBe(true);
    expect(frameTemplateSchema.safeParse({ html: "<p>ok</p>", script: "1;" }).success).toBe(true);
    expect(frameTemplateSchema.safeParse({ html: "</body><script>x</script>" }).success).toBe(
      false,
    );
    expect(
      frameTemplateSchema.safeParse({ html: "<p>ok</p>", script: "'</SCRIPT>'" }).success,
    ).toBe(false);
    expect(frameTemplateSchema.safeParse({ html: "<p>ok</p>", script: "" }).success).toBe(false);
    expect(
      frameMountRequestSchema.safeParse({
        title: "T",
        theme: "dark",
        style: "</style><script>x</script>",
        template: { html: "" },
      }).success,
    ).toBe(false);
    expect(frameTemplateSchema.safeParse({ html: "<p>ok</p>", main: "index.js" }).success).toBe(
      false,
    );
    expect(
      cardFrameMountRequestSchema.safeParse({
        title: "Card",
        theme: "dark",
        style: "",
        template: { html: '<script>const sample = "</body>";</script>' },
        kind: "card",
      }).success,
    ).toBe(true);
  });
});

describe("a panel mount request", () => {
  const base = { title: "Tasks", theme: "dark", style: "body{}", kind: "panel" };

  it("names one of the app's own panels or an added panel's compiled version, and nothing else", () => {
    const ok = (panel: unknown, config: unknown = { id: "now", reads: [], sql: [] }) =>
      frameMountRequestSchema.safeParse({ ...base, panel, config }).success;
    expect(ok({ source: "builtin", id: "now" })).toBe(true);
    expect(ok({ source: "installed", id: "token-meter", version: "0123456789abcdef" })).toBe(true);
    // Not a panel the bundle carries, not a compiler version, not a path.
    expect(ok({ source: "builtin", id: "observe" })).toBe(false);
    expect(ok({ source: "installed", id: "token-meter", version: "../../main" })).toBe(false);
    expect(ok({ source: "installed", id: "../x", version: "0123456789abcdef" })).toBe(false);
    expect(ok({ source: "path", path: "/etc" })).toBe(false);
    // The runtime's config carries only panel reads and published views.
    expect(
      ok({ source: "builtin", id: "now" }, { id: "now", reads: ["tasks.board"], sql: [] }),
    ).toBe(true);
    expect(
      ok({ source: "builtin", id: "now" }, { id: "now", reads: ["observe.sessions"], sql: [] }),
    ).toBe(false);
    expect(ok({ source: "builtin", id: "now" }, { id: "now", reads: [], sql: ["cards"] })).toBe(
      false,
    );
    // A panel mount carries no template to hash and serve.
    expect(
      frameMountRequestSchema.safeParse({
        ...base,
        panel: { source: "builtin", id: "now" },
        config: { id: "now", reads: [], sql: [] },
        template: { html: "<script>1</script>" },
      }).success,
    ).toBe(false);
  });

  it("writes JSON a script element cannot be closed by", () => {
    const text = scriptSafeJson({ id: "</script><script>alert(1)</script>", n: "a&b>" });
    expect(text).not.toMatch(/[<>&]/);
    expect(JSON.parse(text)).toEqual({ id: "</script><script>alert(1)</script>", n: "a&b>" });
  });
});
