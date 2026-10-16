import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StageEntry } from "./SurfaceReveal";

const entry = (ready: boolean) =>
  renderToStaticMarkup(
    // biome-ignore lint/a11y/useValidAriaRole: StageEntry role is a stage slot identity, not an ARIA role.
    <StageEntry entryId="card-1" role="shown" ready={ready} enabled={false} initial={false}>
      <button type="button">Build it</button>
    </StageEntry>,
  );

describe("stage entry readiness", () => {
  it("keeps a loading successor mounted but unavailable to focus and assistive technology", () => {
    const pending = entry(false);
    expect(pending).toContain('inert=""');
    expect(pending).toContain('aria-hidden="true"');
    expect(pending).toContain("Build it</button>");
  });

  it("makes the successor available once its body draws", () => {
    const ready = entry(true);
    expect(ready).not.toContain("inert=");
    expect(ready).not.toContain("aria-hidden=");
  });
});
