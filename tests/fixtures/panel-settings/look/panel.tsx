import type { PanelProps } from "@infinitary/contracts";
import { Button } from "@infinitary/ui";
import { useEffect, useState } from "react";

/**
 * The look fixture (tests/e2e/panel-settings-change.spec.ts): a panel granted two
 * settings, the theme and the window's size, that changes them on the
 * captain's press - and tries to on its own as it opens, and once for a
 * setting its manifest does not name.
 */
type ChangeResult = { ok: true } | { ok: false; text: string };
const say = (result: ChangeResult) => (result.ok ? "changed" : result.text);

type Press = "light" | "dark" | "larger" | "unlisted";

export default function Panel({ settings }: PanelProps) {
  const [feedback, setFeedback] = useState<{ press: Press; text: string }>();
  const report = (press: Press, request: Promise<ChangeResult>) => {
    setFeedback({ press, text: "pending" });
    void request.then((result) => setFeedback({ press, text: say(result) }));
  };
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
        onClick={() => report("light", settings.change("theme", { theme: "light" }))}
      >
        Light
      </Button>
      <Button
        data-look-dark=""
        onClick={() => report("dark", settings.change("theme", { theme: "dark" }))}
      >
        Dark
      </Button>
      <Button
        data-look-larger=""
        onClick={() => report("larger", settings.change("window-size", { size: 110 }))}
      >
        Larger
      </Button>
      <Button
        data-look-unlisted=""
        onClick={() => report("unlisted", settings.change("crew-model-names", { visible: false }))}
      >
        Hide model names
      </Button>
      <p data-look-said={feedback?.press ?? ""}>{feedback?.text}</p>
      <p data-look-unasked="">{unasked}</p>
    </div>
  );
}
