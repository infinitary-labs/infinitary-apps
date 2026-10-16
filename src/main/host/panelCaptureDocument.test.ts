import { describe, expect, it } from "vitest";
import { buildCaptureHtml } from "./panelCaptureDocument";

describe("buildCaptureHtml", () => {
  it("paints the requested theme on a document that is not the live page", () => {
    const html = buildCaptureHtml({
      css: ":root { --bg-0: #05070d } [data-theme='light'] { --bg-0: #eef1f7 }",
      panelHtml: '<section data-side-panel="clock">Tokyo</section>',
      theme: "light",
      width: 280.4,
      height: 120.2,
    });
    expect(html).toContain('<html data-theme="light">');
    expect(html).toContain('<body data-theme="light">');
    expect(html).toContain("Tokyo");
    expect(html).toContain("width: 280px");
    expect(html).toContain("height: 120px");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain("<script");
  });

  it("does not let copied css close the style element", () => {
    const html = buildCaptureHtml({
      css: "/* </style> */",
      panelHtml: "<section></section>",
      theme: "dark",
      width: 10,
      height: 10,
    });
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    expect(html).toContain("<\\/style");
  });
});
