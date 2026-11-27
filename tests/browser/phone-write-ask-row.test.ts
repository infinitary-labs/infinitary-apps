import { FRAME_BRIDGE_VERSION } from "@shared/plugins/bridge";
import { frameCsp } from "@shared/plugins/containment";
import { buildFrameDocument } from "@shared/plugins/frameDocument";
import type { WriteAsk } from "@shared/writeAsk";
import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import { phoneTextRule } from "../../ios/Infinitary/CardRuntime/textSize";
import { cardStylesheet } from "../../src/renderer/src/cards/prototypeSrcdoc";

/**
 * The captain's photo of an "Allow writes on GitHub?" card on an iPhone: the row that joined while the card waited
 * drew its request one character per line, squeezed beside its "Joined while this card waited" tag and its Allow box.
 * A joined row's request keeps the width of a row without the tag. The card's real body and stylesheet with the
 * phone's rule at its default Text Size, in the 329-pixel body an iPhone 16 gives a card.
 */

const FRAME = "phone-write-ask-row";
const REPO = "/repos/example-org/example-app";

const base = {
  kind: "github",
  host: "github.com",
  place: "GitHub",
  via: "project",
  method: "POST",
  card: "c",
} as const;
const asks: WriteAsk[] = [
  {
    ...base,
    id: "write-1",
    at: 1,
    path: `${REPO}/issues/71/comments`,
    body: JSON.stringify({ body: "Fixed in the next version." }),
  },
  {
    ...base,
    id: "write-2",
    at: 2,
    path: `${REPO}/issues/72/comments`,
    body: JSON.stringify({ body: "Reproduced. A fix is under way." }),
  },
];

function requestWidths(): Promise<{ plain: number; joined: number }> {
  return commands.evaluateInFrame(
    FRAME,
    (() => {
      const width = (row: string) =>
        (
          document.querySelector(`[data-inf-ask-row="${row}"] .inf-ask-call`) as Element
        ).getBoundingClientRect().width;
      return { plain: width("write-1"), joined: width("write-2") };
    }).toString(),
  ) as Promise<{ plain: number; joined: number }>;
}

test("on the phone a row that joined while the card waited keeps its request as wide as a row without the tag", async () => {
  const body = await commands.readerApprovalCardBody(asks, ["write-2"]);
  const frame = document.createElement("iframe");
  frame.name = FRAME;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.cssText = "width:329px;height:800px;border:0";
  addEventListener("message", (event) => {
    const data = event.data as { type?: string; document?: string };
    if (event.source !== frame.contentWindow || data.type !== "ready") return;
    frame.contentWindow?.postMessage(
      { fm: FRAME_BRIDGE_VERSION, type: "initialize", document: data.document },
      "*",
    );
  });
  frame.srcdoc = buildFrameDocument({
    csp: frameCsp([]),
    theme: "dark",
    style: `${cardStylesheet()}${phoneTextRule(17 / 14)}`,
    html: body,
  });
  document.body.replaceChildren(frame);

  await expect.poll(async () => (await requestWidths()).plain).toBeGreaterThan(0);
  const { plain, joined } = await requestWidths();
  expect(joined).toBeCloseTo(plain, 0);
});
