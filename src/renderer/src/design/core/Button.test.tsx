import { VIEW_DRIVER_WORDS } from "@shared/taskBrowser";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";
import { IconButton } from "./IconButton";

// INF-27 (FI3-1540): a control that cannot be pressed for a reason stays a
// keyboard stop, and assistive technology reads the reason.
describe("a button marked off", () => {
  it("stays a Tab stop, marked aria-disabled, with its note as its description", () => {
    const html = renderToStaticMarkup(
      <Button off note="Changes are off until MacBook Pro is back">
        Approve
      </Button>,
    );
    expect(html).not.toMatch(/\sdisabled=""/);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-description="Changes are off until MacBook Pro is back"');
    expect(html).not.toContain("title=");
  });

  it("keeps its reason as its description while another place already shows it", () => {
    // A card's buttons while the notice under the top bar shows the sentence
    // whole: no label of their own (no note), the reason still read.
    const html = renderToStaticMarkup(
      <Button off aria-description="Changes are off until MacBook Pro is back">
        Approve
      </Button>,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-description="Changes are off until MacBook Pro is back"');
  });

  it("keeps an icon button off as a stop too, its label naming why", () => {
    const label = `Back · ${VIEW_DRIVER_WORDS.crewmate}`;
    const html = renderToStaticMarkup(
      <IconButton label={label} off>
        ‹
      </IconButton>,
    );
    expect(html).not.toMatch(/\sdisabled=""/);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain(`aria-label="${label}"`);
  });
});
