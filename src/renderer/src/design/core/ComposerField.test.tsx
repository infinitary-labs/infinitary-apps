import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerField } from "./ComposerField";

describe("ComposerField focus presentation", () => {
  it.each(["main-message", "reply"] as const)(
    "%s leaves the focus ring to its surrounding shell",
    (messageField) => {
      const html = renderToStaticMarkup(
        <ComposerField
          messageField={messageField}
          value="A draft"
          lineCap={8}
          onChange={() => {}}
          canSend
        />,
      );
      // The rendered field must override the window's generic focus shadow,
      // just as it overrides the browser outline. The shell draws the ring.
      expect(html).toContain("outline:none");
      expect(html).toContain("box-shadow:none");
    },
  );
});
