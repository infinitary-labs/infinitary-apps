import { SECRET_ASK_CARD_WORDS } from "@shared/secrets";
import { describe, expect, it } from "vitest";
import { secretAskBody, secretAskTitle } from "./askCard";
import { secretAskHow } from "./askHow";
import type { WaitingSecretAsk } from "./asks";

// Intent: INF-5516's plan with the captain's write-in ("allow freeform
// content for the 'how to get it' part ... should not mandate a single form
// for every case"): the asker designs its how-to, and the card draws any
// layout made of text, lists, tables, details and links, while a script, a
// style, a field, an unsafe link or a link hiding its address is refused in
// words the asker can act on. Fixtures: the Bitbucket token steps from the
// captain's screenshot of today's card, and a table of Stripe places.

const BITBUCKET = [
  "<ol>",
  '<li>Open <a href="https://bitbucket.org/account/settings/api-tokens/">bitbucket.org/account/settings/api-tokens</a> and choose <strong>Create API token with scopes</strong>.</li>',
  "<li>Name it <code>Infinitary</code> and pick an expiry.</li>",
  '<li>Tick these scopes:<ul class="inf-grid"><li><code>read:repository:bitbucket</code></li><li><code>read:pullrequest:bitbucket</code></li><li><code>write:pullrequest:bitbucket</code></li></ul></li>',
  "<li>Copy the token: Bitbucket shows it only once.</li>",
  "</ol>",
  "<details><summary>Why these scopes</summary><p>Reading and commenting on pull requests, nothing more.</p></details>",
].join("");

const STRIPE_TABLE =
  '<table><thead><tr><th>Place</th><th>Where</th></tr></thead><tbody><tr><td>Test</td><td><a href="https://dashboard.stripe.com/test/apikeys">dashboard.stripe.com/test/apikeys</a></td></tr></tbody></table><p class="inf-muted">Press <kbd>Reveal</kbd>, then copy.</p>';

function drawn(fragment: string): string {
  const how = secretAskHow(fragment);
  if (!how || !("html" in how)) throw new Error(`Refused: ${how?.problem}`);
  return how.html;
}

function problem(fragment: string): string {
  const how = secretAskHow(fragment);
  if (!how || !("problem" in how)) throw new Error("Not refused.");
  return how.problem;
}

describe("an asker's how-to", () => {
  it("draws steps, a grid of exact names and a folded section as written", () => {
    expect(drawn(BITBUCKET)).toBe(BITBUCKET);
  });

  it("draws a table, a muted line and a key as written", () => {
    expect(drawn(STRIPE_TABLE)).toBe(STRIPE_TABLE);
  });

  it("draws again from its elements: comments go, text is escaped, attributes are quoted", () => {
    expect(
      drawn(
        "<p>Copy it <!-- not shown -->& paste it</p><table><tr><td colspan=2>Next</td></tr></table>",
      ),
    ).toBe('<p>Copy it &amp; paste it</p><table><tr><td colspan="2">Next</td></tr></table>');
  });

  it("is none when empty", () => {
    expect(secretAskHow("  \n ")).toBeUndefined();
    expect(secretAskHow("<!-- nothing -->")).toBeUndefined();
  });

  it.each([
    ["a script", "<p>Steps</p><script>alert(1)</script>", "<script>"],
    ["a style", "<style>body{display:none}</style>", "<style>"],
    ["a field", '<p>Paste it here: <input type="password"></p>', "<input>"],
    ["a picture", '<img src="https://example.com/a.png">', "<img>"],
    ["a frame", '<iframe src="https://example.com"></iframe>', "<iframe>"],
    ["a button", "<button>Save</button>", "<button>"],
    ["an inline style", '<p style="color:red">Red</p>', "style"],
    ["a handler", '<p onclick="x()">Press</p>', "onclick"],
    ["a data hook", '<p data-inf-action="merge">Merge</p>', "data-inf-action"],
    ["a class of its own", '<p class="secret-ask-elsewhere">Shown</p>', "secret-ask-elsewhere"],
    ["a number that is not one", '<table><tr><td colspan="1;x">One</td></tr></table>', "colspan"],
    // The card numbers each list's steps itself, from one: a list resumed elsewhere would draw the wrong numbers.
    ["a list's start", '<ol start="4"><li>Four</li></ol>', "start"],
    ["a doctype", "<!doctype html><p>Steps</p>", "doctype"],
  ])("refuses %s, naming it", (_kind, fragment, named) => {
    expect(problem(fragment)).toContain(named);
  });

  it.each([
    ["a script address", '<a href="javascript:alert(1)">javascript:alert(1)</a>'],
    ["a plain web address", '<a href="http://bitbucket.org">http://bitbucket.org</a>'],
    ["a link with no address", "<a>bitbucket.org</a>"],
  ])("refuses a link with %s", (_kind, fragment) => {
    expect(problem(fragment)).toMatch(/link/);
  });

  it("refuses a link that hides part of its address inside an element", () => {
    expect(
      problem(
        '<a href="https://bitbucket.org.evil.example/login">https://bitbucket.org<details><summary></summary>.evil.example/login</details></a>',
      ),
    ).toMatch(/only its address as text/);
    expect(problem('<a href="https://bitbucket.org/">https://<b>bitbucket.org</b></a>')).toMatch(
      /only its address as text/,
    );
  });

  it("refuses a link whose text hides where it goes, and says how to show it", () => {
    const words = problem('<a href="https://evil.example/login">bitbucket.org/account</a>');
    expect(words).toContain('<a href="https://evil.example/login">https://evil.example/login</a>');
  });
});

const ASK: WaitingSecretAsk = {
  key: "task-a:bitbucket",
  task: "task-a",
  id: "bitbucket",
  reason: "Review and comment on the project's pull requests",
  at: 1000,
  fields: [{ id: "s1", name: "Bitbucket API token", place: "" }],
  already: [],
};

describe("the ask card", () => {
  it("names one secret short, the reason in quotes with who wrote it, then the how-to", () => {
    const ask = { ...ASK, how: drawn(BITBUCKET) };
    expect(secretAskTitle(ask)).toBe(SECRET_ASK_CARD_WORDS.title(["Bitbucket API token"], false));
    const body = secretAskBody(ask, "Add Bitbucket support");
    const order = [
      ASK.reason,
      SECRET_ASK_CARD_WORDS.asked("Add Bitbucket support"),
      SECRET_ASK_CARD_WORDS.how(false),
      "read:repository:bitbucket",
      SECRET_ASK_CARD_WORDS.by("task-a"),
    ].map((words) => body.indexOf(words));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("draws no how-to part when the asker gave none", () => {
    const body = secretAskBody(ASK, "Add Bitbucket support");
    expect(body).not.toContain(SECRET_ASK_CARD_WORDS.how(false));
    expect(body).not.toContain(SECRET_ASK_CARD_WORDS.by("task-a"));
  });

  it("says Replace only when every secret replaces a saved one, and never repeats a place in the body", () => {
    const key = {
      id: "s1",
      name: "Stripe test key",
      place: "Test",
      replaces: { ref: "stripe", version: 2, revision: "r2" },
    };
    const hook = { id: "s2", name: "Webhook secret", place: "" };
    const replacing: WaitingSecretAsk = {
      ...ASK,
      fields: [key, { ...hook, replaces: { ref: "hook", version: 1, revision: "r1" } }],
    };
    expect(secretAskTitle(replacing)).toBe(
      SECRET_ASK_CARD_WORDS.title(["Stripe test key", "Webhook secret"], true),
    );
    expect(secretAskTitle({ ...ASK, fields: [key, hook] })).toBe(
      SECRET_ASK_CARD_WORDS.title(["Stripe test key", "Webhook secret"], false),
    );
    expect(secretAskBody(replacing, null)).not.toContain(SECRET_ASK_CARD_WORDS.place("Test"));
  });
});
