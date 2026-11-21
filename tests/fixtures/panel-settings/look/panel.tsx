import type { PanelProps } from "@infinitary/contracts";
import { Button } from "@infinitary/ui";
import { useEffect, useState } from "react";

/**
 * The look fixture (tests/e2e/panel-settings-change.spec.ts): a panel granted two
 * settings, the theme and the window's size, that changes them on the
 * captain's press - and tries to on its own as it opens, twice on one press,
 * and once for a setting its manifest does not name.
 */
const say = (result: { ok: true } | { ok: false; text: string }) =>
  result.ok ? "changed" : result.text;

export default function Panel({ settings }: PanelProps) {
  const [said, setSaid] = useState("");
  const [unasked, setUnasked] = useState("");
  // A change from no press of the captain's: refused, nothing changed.
  useEffect(() => {
    if (!settings) return;
    void settings.change("theme", { theme: "light" }).then((result) => setUnasked(say(result)));
  }, [settings]);
  if (!settings) return <p data-look-none="">No settings</p>;
  return (
    <div data-fixture-look="">
      <Button
        data-look-light=""
        onClick={() =>
          void settings.change("theme", { theme: "light" }).then((r) => setSaid(say(r)))
        }
      >
        Light
      </Button>
      <Button
        data-look-dark=""
        onClick={() =>
          void settings.change("theme", { theme: "dark" }).then((r) => setSaid(say(r)))
        }
      >
        Dark
      </Button>
      <Button
        data-look-twice=""
        onClick={async () => {
          const first = await settings.change("window-size", { size: 110 });
          const second = await settings.change("theme", { theme: "light" });
          setSaid(`${say(first)} / ${say(second)}`);
        }}
      >
        Larger and light
      </Button>
      <Button
        data-look-unlisted=""
        onClick={() =>
          void settings.change("crew-model-names", { visible: false }).then((r) => setSaid(say(r)))
        }
      >
        Hide model names
      </Button>
      <p data-look-said="">{said}</p>
      <p data-look-unasked="">{unasked}</p>
    </div>
  );
}
