import { describe, expect, it } from "vitest";
import {
  type BrowserNode,
  CUT_SHORT,
  FULL_TEXT_MAX,
  HUMAN_CHECK_WORDS,
  outlinePage,
  parseRef,
  passageOf,
  REF_FROM_BEFORE_HANDBACK,
  REF_FROM_EARLIER_PAGE,
  RefBook,
  refusedRefWords,
  TEXT_SHOWN,
} from "./outline";

/**
 * The page as a crewmate reads it. The tree below has the shape Chromium's
 * accessibility tree gives for a small sign-up form (a label wrapping its
 * field, a select with its popup, a password field drawn as bullets).
 */

type Spec = Partial<BrowserNode> & { role: string; children?: Spec[] };

/** A page's book of refs, numbered as a browser's first page read would be. */
function book(number = 1): RefBook {
  return new RefBook(() => number);
}

function tree(root: Spec): BrowserNode[] {
  const nodes: BrowserNode[] = [];
  let next = 1;
  const walk = (spec: Spec): string => {
    const id = String(next);
    next += 1;
    const node: BrowserNode = {
      id,
      role: spec.role,
      name: spec.name ?? "",
      ignored: spec.ignored ?? false,
      childIds: [],
      properties: spec.properties ?? {},
      ...(spec.value !== undefined ? { value: spec.value } : {}),
      ...(spec.target !== undefined ? { target: spec.target } : {}),
      ...(spec.onScreen !== undefined ? { onScreen: spec.onScreen } : {}),
      ...(spec.frameUrl !== undefined ? { frameUrl: spec.frameUrl } : {}),
    };
    nodes.push(node);
    node.childIds = (spec.children ?? []).map(walk);
    return id;
  };
  walk(root);
  return nodes;
}

const text = (name: string): Spec => ({
  role: "StaticText",
  name,
  children: [{ role: "InlineTextBox", name }],
});

const signUp = (): BrowserNode[] =>
  tree({
    role: "RootWebArea",
    name: "Sign up",
    properties: { url: "http://localhost:5173/" },
    children: [
      {
        role: "generic",
        ignored: true,
        children: [
          {
            role: "navigation",
            children: [
              {
                role: "link",
                name: "Next page",
                target: 9,
                properties: { url: "http://localhost:5173/next" },
                children: [text("Next page")],
              },
            ],
          },
          {
            role: "heading",
            name: "Sign up",
            properties: { level: 1 },
            children: [text("Sign up")],
          },
          {
            role: "LabelText",
            children: [text("Name "), { role: "textbox", name: "Name ", target: 12, value: "Sam" }],
          },
          {
            role: "LabelText",
            children: [
              text("Password "),
              { role: "textbox", name: "Password ", target: 15, value: "•••••••" },
            ],
          },
          {
            role: "combobox",
            name: "Seat",
            target: 17,
            value: "Aisle",
            properties: { expanded: false },
            children: [
              {
                role: "MenuListPopup",
                children: [
                  { role: "option", name: "Aisle", target: 24, properties: { selected: true } },
                  { role: "option", name: "Window", target: 27 },
                ],
              },
            ],
          },
          { role: "checkbox", name: "Remember me", target: 29, properties: { checked: "false" } },
          { role: "button", name: "Send", target: 30, children: [text("Send")] },
          { role: "button", name: "Pay", target: 31, properties: { disabled: true } },
          { role: "paragraph", children: [text("nothing   yet")] },
          { role: "image", name: "Logo" },
        ],
      },
    ],
  });

/**
 * A payment page the captain handed back: card fields he typed into and
 * never sent - each with the inner text Chromium gives an input - a name
 * the crewmate typed, a country a list completed as he typed, a card type
 * chosen from the site's own list, and a note in an editable part of the
 * page.
 */
const checkout = (): BrowserNode[] => {
  const field = (name: string, target: number, value: string, role = "textbox"): Spec => ({
    role,
    name,
    target,
    value,
    properties: { editable: "plaintext" },
    children: [
      {
        role: "generic",
        properties: { editable: "plaintext" },
        children: [{ ...text(value), properties: { editable: "plaintext" } }],
      },
    ],
  });
  return tree({
    role: "RootWebArea",
    name: "Review and pay",
    children: [
      { role: "heading", name: "Review and pay", properties: { level: 1 } },
      {
        role: "form",
        children: [
          field("Name on card", 40, "Sam Rivera"),
          field("Card number", 41, "4111 1111 1111 1111"),
          field("Expiry", 42, "12/29"),
          { ...field("Security code", 43, "737", "spinbutton"), properties: {} },
          field("Billing country", 44, "Portugal", "combobox"),
          {
            role: "combobox",
            name: "Card type",
            target: 45,
            value: "Visa",
            properties: { expanded: false },
            children: [
              {
                role: "MenuListPopup",
                children: [
                  { role: "option", name: "Mastercard", target: 46 },
                  { role: "option", name: "Visa", target: 47, properties: { selected: true } },
                ],
              },
            ],
          },
          {
            role: "generic",
            properties: { editable: "richtext" },
            children: [
              { ...text("Leave it with the concierge"), properties: { editable: "richtext" } },
            ],
          },
          { role: "button", name: "Pay €312.00", target: 50, children: [text("Pay €312.00")] },
        ],
      },
    ],
  });
};

/**
 * A shop's checkout whose card form is a frame from its payment provider,
 * signed in with a human check in another frame, as Chromium's tree reads
 * once the host has read each frame's document beneath its frame's node,
 * and an advert frame it could not read.
 */
const framedCheckout = (): BrowserNode[] =>
  tree({
    role: "RootWebArea",
    name: "Checkout",
    children: [
      { role: "heading", name: "Checkout", properties: { level: 1 } },
      {
        role: "Iframe",
        name: "Secure card payment",
        target: 60,
        // Its title names the frame, and none of what its document shows.
        properties: { title: "Secure card payment" },
        frameUrl: "https://js.pay.example/elements/card?key=pk_live_1",
        children: [
          {
            role: "RootWebArea",
            name: "Card",
            children: [
              {
                role: "textbox",
                name: "Card number",
                target: 2147483709,
                value: "4111 1111 1111 1111",
                properties: { editable: "plaintext" },
              },
              {
                role: "textbox",
                name: "Name on card",
                target: 2147483710,
                value: "Sam Rivera",
                properties: { editable: "plaintext" },
              },
            ],
          },
        ],
      },
      {
        role: "Iframe",
        name: "Widget containing a Cloudflare security challenge",
        target: 61,
        frameUrl: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/ov2",
        children: [
          {
            role: "RootWebArea",
            children: [
              {
                role: "checkbox",
                name: "Verify you are human",
                target: 4294967360,
                properties: { checked: "false" },
              },
            ],
          },
        ],
      },
      { role: "Iframe", target: 62, frameUrl: "https://ads.example/slot" },
      { role: "button", name: "Place order", target: 63, children: [text("Place order")] },
    ],
  });

describe("frames", () => {
  it("reads a frame's document under a line naming its site, with refs to its controls", () => {
    const refs = book();
    const outline = outlinePage(framedCheckout(), refs);
    expect(outline.text.split("\n")).toEqual([
      'heading "Checkout" (level 1)',
      'frame "Secure card payment" from js.pay.example',
      '  textbox "Card number" [g1:e1]: "4111 1111 1111 1111"',
      '  textbox "Name on card" [g1:e2]: "Sam Rivera"',
      `frame "Widget containing a Cloudflare security challenge" from challenges.cloudflare.com: ${HUMAN_CHECK_WORDS}`,
      '  checkbox "Verify you are human" [g1:e3] (not checked)',
      "frame from ads.example (its content could not be read)",
      'button "Place order" [g1:e4]',
    ]);
    // The element inside the frame keeps the host's number for it, and its check.
    expect(refs.resolve("g1:e1")).toMatchObject({ target: 2147483709 });
    expect(refs.resolve("g1:e1")?.check).toBeUndefined();
    expect(refs.resolve("g1:e3")).toMatchObject({
      target: 4294967360,
      check: "challenges.cloudflare.com",
    });
    expect(refs.resolve("g1:e4")?.check).toBeUndefined();
  });

  it("hides what the captain typed inside a frame, as on the page itself", () => {
    const refs = book();
    refs.noteTyped(2147483710, "Sam Rivera");
    const outline = outlinePage(framedCheckout(), refs, { typedOnly: true });
    expect(outline.text).toContain('  textbox "Card number" [g1:e1] (value hidden)');
    expect(outline.text).toContain('  textbox "Name on card" [g1:e2]: "Sam Rivera"');
    expect(outline.text).not.toContain("4111");
    expect(outline.words).not.toContain("4111");
    expect(outline.withheld).toEqual(['textbox "Card number" [g1:e1]']);
  });

  it("names a frame's site without the query of its address", () => {
    const text = outlinePage(framedCheckout(), book(), { withholdQueries: true }).text;
    expect(text).not.toContain("pk_live_1");
  });
});

describe("the page outline", () => {
  it("reads headings, text and controls, one line each, with a ref for each control", () => {
    const outline = outlinePage(signUp(), book(), { pageUrl: "http://localhost:5173/" });
    expect(outline.text.split("\n")).toEqual([
      "navigation",
      '  link "Next page" [g1:e1] → /next',
      'heading "Sign up" (level 1)',
      'textbox "Name" [g1:e2]: "Sam"',
      'textbox "Password" [g1:e3] (value hidden)',
      'combobox "Seat" [g1:e4]: "Aisle" (options: Aisle, Window) (collapsed)',
      'checkbox "Remember me" [g1:e5] (not checked)',
      'button "Send" [g1:e6]',
      'button "Pay" [g1:e7] (disabled)',
      'text "nothing yet"',
      'image "Logo"',
    ]);
    expect(outline.lines.map((line) => line.text)).toEqual(outline.text.split("\n"));
    expect(outline.words).toContain("nothing yet");
  });

  it("reads links without their query and fragment on a page that may show the captain's account", () => {
    const nodes = tree({
      role: "RootWebArea",
      name: "My bookings",
      children: [
        {
          role: "link",
          name: "Manage booking",
          target: 3,
          properties: { url: "https://aurora.example/manage?ref=AUR-7K2Q&token=s3cret#pay" },
        },
        {
          role: "link",
          name: "Help",
          target: 4,
          properties: { url: "https://help.example/ask?session=abc" },
        },
      ],
    });
    const options = { pageUrl: "https://aurora.example/bookings" };
    expect(outlinePage(nodes, book(), options).text).toContain("token=s3cret");
    const bare = outlinePage(nodes, book(), { ...options, withholdQueries: true }).text;
    expect(bare.split("\n")).toEqual([
      'link "Manage booking" [g1:e1] → /manage',
      'link "Help" [g1:e2] → https://help.example/ask',
    ]);
  });

  it("reads only the text the crewmate typed itself, once the captain has held the page", () => {
    const refs = book();
    refs.noteTyped(40, "Sam Rivera");
    const outline = outlinePage(checkout(), refs, { typedOnly: true });
    expect(outline.text.split("\n")).toEqual([
      'heading "Review and pay" (level 1)',
      "form",
      '  textbox "Name on card" [g1:e1]: "Sam Rivera"',
      '  textbox "Card number" [g1:e2] (value hidden)',
      '  textbox "Expiry" [g1:e3] (value hidden)',
      '  spinbutton "Security code" [g1:e4] (value hidden)',
      '  combobox "Billing country" [g1:e5] (value hidden)',
      // A choice from the site's own list is the site's words, not typing.
      '  combobox "Card type" [g1:e6]: "Visa" (options: Mastercard, Visa) (collapsed)',
      "  editable text (value hidden)",
      '  button "Pay €312.00" [g1:e7]',
    ]);
    // Nothing he typed is in the words a wait reads either.
    for (const typed of ["4111 1111 1111 1111", "12/29", "737", "Portugal", "concierge"]) {
      expect(outline.text).not.toContain(typed);
      expect(outline.words).not.toContain(typed);
    }
    expect(outline.withheld).toEqual([
      'textbox "Card number" [g1:e2]',
      'textbox "Expiry" [g1:e3]',
      'spinbutton "Security code" [g1:e4]',
      'combobox "Billing country" [g1:e5]',
      "editable text",
    ]);
  });

  it("reads a field only while it holds just what the crewmate typed", () => {
    const refs = book();
    // Its typing did not replace all he had typed: what is left may be his.
    refs.noteTyped(41, "4111");
    const outline = outlinePage(checkout(), refs, { typedOnly: true });
    expect(outline.text).toContain('textbox "Card number" [g1:e2] (value hidden)');
    expect(outline.text).not.toContain("4111");
  });

  it("reads every value on a page the captain has not held, and names nothing withheld", () => {
    const outline = outlinePage(checkout(), book());
    expect(outline.text).toContain('textbox "Card number" [g1:e2]: "4111 1111 1111 1111"');
    expect(outline.text).toContain('spinbutton "Security code" [g1:e4]: "737"');
    expect(outline.text).toContain('text "Leave it with the concierge"');
    expect(outline.withheld).toEqual([]);
  });

  it("forgets what the crewmate typed with its book, and names everything it holds back", () => {
    const refs = book();
    refs.noteTyped(40, "Sam Rivera");
    outlinePage(checkout(), refs, { typedOnly: true });
    // The captain handed the page back again: a new book, and nothing the crewmate typed before.
    const fresh = outlinePage(checkout(), book(), { typedOnly: true });
    expect(fresh.lines[0]?.text).toBe('heading "Review and pay" (level 1)');
    expect(fresh.lines).toHaveLength(10);
    expect(fresh.withheld).toHaveLength(6);
    expect(fresh.withheld[0]).toBe('textbox "Name on card" [g1:e1]');
  });

  it("keeps an element's ref across reads of one document, and starts again for a new one", () => {
    const refs = book(3);
    expect(refs.number).toBeUndefined();
    outlinePage(signUp(), refs);
    const again = outlinePage(signUp(), refs);
    expect(refs.number).toBe(3);
    expect(again.text).toContain('button "Send" [g3:e6]');
    expect(refs.resolve("G3:E6")).toMatchObject({ target: 30, role: "button", name: "Send" });
    expect(refs.resolve("g3:e99")).toBeUndefined();
    // A bare control number names no page, so it names nothing.
    expect(refs.resolve("e6")).toBeUndefined();
    // The next document's book has a number of its own: the old ref is not in it.
    const next = book(4);
    expect(outlinePage(signUp(), next).text).toContain('button "Send" [g4:e6]');
    expect(next.resolve("g3:e6")).toBeUndefined();
    expect(next.resolve("g4:e6")).toMatchObject({ target: 30 });
  });

  it("numbers a book only once a read names a ref from it", () => {
    let minted = 0;
    const refs = new RefBook(() => {
      minted += 1;
      return 7;
    });
    const plain = tree({ role: "RootWebArea", children: [{ role: "heading", name: "Hello" }] });
    outlinePage(plain, refs);
    expect(refs.number).toBeUndefined();
    outlinePage(signUp(), refs);
    outlinePage(signUp(), refs);
    expect(refs.number).toBe(7);
    expect(minted).toBe(1);
  });

  it("reads a ref's book and control only from a whole ref", () => {
    expect(parseRef(" G12:e5 ")).toEqual({ book: 12, control: 5 });
    expect(parseRef("e5")).toBeUndefined();
    expect(parseRef("[g1:e5]")).toBeUndefined();
    expect(parseRef("g1:e")).toBeUndefined();
  });

  it("refuses a ref in words that say where it came from", () => {
    expect(refusedRefWords("e5", { kind: "not-a-ref" })).toContain(
      '"e5" is not a whole ref. A ref names the page it came from as well as its control',
    );
    expect(refusedRefWords("g2:e9", { kind: "this-page" })).toContain(
      "There is no g2:e9 on the page now.",
    );
    expect(refusedRefWords("g1:e3", { kind: "other-page", page: 1, current: 2 })).toBe(
      "g1:e3 is a ref on page 1, and your commands act on page 2 now. Use this page's refs, or switch with `infinitary-browser-axi selectpage 1`.",
    );
    expect(refusedRefWords("g1:e44", { kind: "earlier-page" })).toContain(
      `g1:e44 ${REF_FROM_EARLIER_PAGE}, so it is not used on the page now.`,
    );
    expect(refusedRefWords("g1:e3", { kind: "handed-back" })).toContain(
      `g1:e3 ${REF_FROM_BEFORE_HANDBACK}.`,
    );
    expect(refusedRefWords("g1:e3", { kind: "earlier-browser" })).toContain(
      "g1:e3 is from a browser this task had before, which has stopped.",
    );
    expect(refusedRefWords("g9:e1", { kind: "unknown" })).toContain(
      "There is no g9:e1 in this browser.",
    );
    // Each one but the other page's sends the crewmate to the refs it has now.
    expect(refusedRefWords("g1:e44", { kind: "earlier-page" })).toContain(
      "Use a ref from the latest answer, or run `infinitary-browser-axi snapshot` for the page's refs now.",
    );
  });

  it("reads every line of a long page, each with its words and where the window shows it", () => {
    const long = tree({
      role: "RootWebArea",
      children: Array.from({ length: 30 }, (_, index) => ({
        ...text(`Row ${index + 1}`),
        onScreen: index < 10,
      })),
    });
    const outline = outlinePage(long, book());
    // Which lines one answer shows is the window's (`window.ts`), never the outline's.
    expect(outline.lines).toHaveLength(30);
    expect(outline.lines[29]).toMatchObject({
      text: 'text "Row 30"',
      role: "text",
      onScreen: false,
    });
    expect(outline.lines[0]?.onScreen).toBe(true);
    expect(outline.lines[29]?.words).toContain("Row 30");
    expect(outline.words).toContain("Row 30");
  });

  it("places a line the host could not place where its parent is", () => {
    const nodes = tree({
      role: "RootWebArea",
      children: [
        {
          role: "list",
          onScreen: false,
          children: [{ role: "listitem", children: [text("Off")] }],
        },
      ],
    });
    expect(outlinePage(nodes, book()).lines.map((line) => line.onScreen)).toEqual([
      false,
      false,
      false,
    ]);
    const unknown = tree({ role: "RootWebArea", children: [text("Somewhere")] });
    expect(outlinePage(unknown, book()).lines[0]?.onScreen).toBeUndefined();
  });

  it("never lets a search read what it keeps back", () => {
    const refs = book();
    const outline = outlinePage(checkout(), refs, { typedOnly: true });
    const words = outline.lines.map((line) => line.words).join("\n");
    expect(words).toContain("Card number");
    expect(words).not.toContain("4111");
    expect(words).not.toContain("concierge");
  });

  it("marks a long passage cut short and names a ref, while a wait reads past the cut", () => {
    const tail = "the rest of the release notes";
    const passage = `${"a".repeat(TEXT_SHOWN)} ${tail}`;
    const nodes = tree({
      role: "RootWebArea",
      children: [{ role: "StaticText", name: passage, target: 8 }],
    });
    const outline = outlinePage(nodes, book());
    expect(outline.text).toContain(`(${CUT_SHORT})`);
    expect(outline.text).toMatch(/\[g1:e1\]/);
    expect(outline.text).not.toContain(tail);
    expect(outline.words).toContain(tail);
  });

  it("names a time element's exact time and a title tooltip on the text inside it", () => {
    const nodes = tree({
      role: "RootWebArea",
      children: [
        {
          role: "time",
          properties: {
            datetime: "2026-10-08T21:52:52Z",
            title: "Oct 8, 2026, 2:52 PM PDT",
          },
          children: [text("2 hours ago")],
        },
      ],
    });
    const outline = outlinePage(nodes, book());
    expect(outline.text).toContain('text "2 hours ago"');
    expect(outline.text).toContain("time: 2026-10-08T21:52:52Z");
    expect(outline.text).toContain('title: "Oct 8, 2026, 2:52 PM PDT"');
  });

  it("reads a cut passage in full, and still hides what the captain typed", () => {
    const passage = `${"n".repeat(FULL_TEXT_MAX + 25)}`;
    const nodes = tree({
      role: "RootWebArea",
      children: [{ role: "StaticText", name: passage, target: 8 }],
    });
    const node = nodes.find((item) => item.target === 8);
    if (!node) throw new Error("missing passage");
    const full = passageOf(node, book());
    expect(full).toMatchObject({ hidden: false, omitted: 25 });
    const hidden = passageOf(
      {
        id: "c",
        role: "textbox",
        name: "Card number",
        value: "4111 1111 1111 1111",
        ignored: false,
        childIds: [],
        target: 41,
        properties: {},
      },
      book(),
      { typedOnly: true },
    );
    expect(hidden).toEqual({ hidden: true });
  });
});
