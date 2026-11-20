import type { PanelProps } from "@firstmate/contracts";
import { Button, Input } from "@firstmate/ui";
import { useState } from "react";

/**
 * The settings-pointer fixture (tests/e2e/settings-handover-cards.spec.ts):
 * a panel of the person's own that opens a place in Settings through
 * `point.openSettings`, naming the section by its button and the item by
 * what is typed in its field, and says what each call answered.
 */
const SECTIONS = ["projects", "devices", "secrets"] as const;

export default function Panel({ id, point }: PanelProps) {
  const [item, setItem] = useState("");
  const [said, setSaid] = useState("");
  const open = (section: string) => {
    const named = item.trim();
    void point
      .openSettings(section, named === "" ? undefined : named)
      .then((opened) => setSaid(`${section} ${opened ? "opened" : "not opened"}`))
      .catch(() => setSaid(`${section} refused`));
  };
  return (
    <div data-fixture={id}>
      <Input
        aria-label="Item to show"
        data-pointer-item=""
        value={item}
        onChange={(event) => setItem(event.currentTarget.value)}
      />
      {SECTIONS.map((section) => (
        <Button key={section} size="sm" data-pointer-open={section} onClick={() => open(section)}>
          {`Open ${section}`}
        </Button>
      ))}
      <output data-pointer-said="">{said}</output>
    </div>
  );
}
