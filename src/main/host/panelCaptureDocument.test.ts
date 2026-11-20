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

  // INF-2205 piece C: every panel draws in its own frame, so its markup is
  // not in the window's copy; capture_panel sets each frame's reading back.
  it("sets each panel frame's own reading back in place, script-free and in the requested theme", () => {
    const html = buildCaptureHtml({
      css: "",
      panelHtml:
        '<section data-side-panel="clock"><div data-capture-frame="0"></div><div data-capture-frame="1"></div></section>',
      frames: [
        {
          css: "p { color: red }",
          bodyHtml: '<p title="a&b">Tokyo 9:05 "AM"</p>',
          width: 279.6,
          height: 40.2,
        },
      ],
      theme: "light",
      width: 280,
      height: 120,
    });
    const srcdoc = /<iframe srcdoc="([^"]*)" style="([^"]*)"><\/iframe>/.exec(html);
    expect(srcdoc?.[2]).toBe("border:0;display:block;width:280px;height:40px");
    const inner = (srcdoc?.[1] ?? "").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
    expect(inner).toContain('<html data-theme="light">');
    expect(inner).toContain('<p title="a&b">Tokyo 9:05 "AM"</p>');
    expect(inner).toContain("p { color: red }");
    expect(inner).toContain("default-src 'none'");
    // A marker with no reading is dropped, never left as an empty box.
    expect(html).not.toContain("data-capture-frame");
    expect(html.match(/<iframe/g)).toHaveLength(1);
    expect(html).not.toContain("<script");
  });
});
