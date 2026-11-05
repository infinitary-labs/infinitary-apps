import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FRAME_CSP, frameCsp } from "@shared/plugins/containment";
import type { DocumentMountRequest } from "@shared/plugins/frameDocument";
import { FRAME_BRIDGE_SCRIPT, FRAME_BRIDGE_SHA256 } from "@shared/plugins/frameScript";
import { describe, expect, it } from "vitest";
import { expectBytesEqual } from "../../../tests/helpers/expectBytes";
import { projectFontBytes } from "../../../tests/helpers/fontFixture";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { CARD_MOUNT_CAP, FrameMountRegistry, scriptHash } from "./frameMounts";
import { answerFrameRequest, MEDIA_PIECE_BYTES, type PictureSource } from "./frameProtocol";

const request = (script?: string): DocumentMountRequest => ({
  title: "Probe",
  theme: "dark",
  style: "body { color: var(--fg-1); }",
  template: { html: "<main data-probe>hi</main>", ...(script ? { script } : {}) },
});

const cardRequest = (script: string): DocumentMountRequest => ({
  title: "Probe",
  theme: "dark",
  style: "body { color: var(--fg-1); }",
  template: { html: `<main data-probe>hi</main><script>${script}</script>` },
  kind: "card",
});

describe("FrameMountRegistry", () => {
  it("serves a mounted template at a random url with its own hash-pinned CSP", () => {
    const ids = ["first", "second"];
    const mounts = new FrameMountRegistry({ newId: () => ids.shift() ?? "" });
    const script = "document.querySelector('[data-probe]').textContent = 'ran';";
    const mount = mounts.mount(request(script));
    expect(mount).toEqual({ mountId: "first", url: "app-frame://mount/first" });
    const served = mounts.document("first");
    expect(served?.csp).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; font-src app-frame:; img-src data: app-frame:; script-src '${FRAME_BRIDGE_SHA256}' '${scriptHash(script)}'`,
    );
    expect(served?.body).toContain(FRAME_BRIDGE_SCRIPT);
    expect(served?.body).toContain(`<script>${script}</script>`);
    // The bridge is the only host script, and it runs before the markup and
    // the template script.
    const body = served?.body ?? "";
    const bridgeAt = body.indexOf(`<script>${FRAME_BRIDGE_SCRIPT}</script>`);
    expect(bridgeAt).toBeGreaterThan(-1);
    expect(body.indexOf("<main data-probe>")).toBeGreaterThan(bridgeAt);
    expect(served?.body).toContain('<html data-theme="dark">');
    expect(served?.body).toContain("<title>Probe</title>");
    // The document's own meta carries the same policy as the header will.
    expect(served?.body).toContain(`content="${served?.csp.replaceAll('"', "&quot;")}"`);
  });

  it("pins each inline script the markup carries, in place, and drops a script with src", () => {
    // A card body is served verbatim (there is no sanitizer), so its own
    // scripts stay where their author put them and the host is what makes
    // them run: one hash each, deduped, and nothing else.
    const mounts = new FrameMountRegistry({ newId: () => "card" });
    const first = "window.__first = 1;";
    const second = "window.__second = 2;";
    const html =
      `<p>Drawn.</p><script>${first}</script>` +
      `<svg><script>${second}</script></svg>` +
      `<script>${first}</script>` +
      `<script src="https://evil.example/x.js"></script><script></script>`;
    mounts.mount({ ...request(), template: { html }, kind: "card" });
    const served = mounts.cardDocument("card");
    expect(served?.csp).toBe(frameCsp([scriptHash(first), scriptHash(second)]));
    // The markup reaches the document unchanged, `script src` included: it
    // stays in the page and never loads, because nothing hashes it and
    // `default-src 'none'` refuses the fetch.
    expect(served?.body).toContain(html);
    expect(served?.csp).not.toContain(scriptHash(""));
  });

  it("normalizes inline script line endings for CSP without changing the served card", () => {
    const mounts = new FrameMountRegistry({ newId: () => "windows-lines" });
    const script = "window.__first = 1;\r\nwindow.__second = 2;\rwindow.__third = 3;";
    const normalized = "window.__first = 1;\nwindow.__second = 2;\nwindow.__third = 3;";
    const html = `<script>${script}</script>`;
    mounts.mount({ ...request(), template: { html }, kind: "card" });
    const served = mounts.cardDocument("windows-lines");
    expect(served?.csp).toBe(frameCsp([scriptHash(normalized)]));
    expect(served?.body).toContain(html);
    expect(served?.csp).not.toContain(scriptHash(script));
  });

  it("mounts a verbatim card body containing closing-body text", () => {
    const mounts = new FrameMountRegistry({ newId: () => "closing-body" });
    const html = '<p role="status">mounted</p><script>const sample = "</body>";</script>';
    mounts.mount({ ...request(), template: { html }, kind: "card" });
    expect(mounts.cardDocument("closing-body")?.body).toContain(html);
  });

  it("does not pin or run an inline script carried by plugin template markup", () => {
    const mounts = new FrameMountRegistry({ newId: () => "template-inline" });
    const script = "window.__inline = 1;";
    const html = `<main>Still markup.</main><script>${script}</script>`;
    mounts.mount({ ...request(), template: { html } });
    const served = mounts.document("template-inline");
    expect(served?.csp).toBe(FRAME_CSP);
    expect(served?.csp).not.toContain(scriptHash(script));
    expect(served?.body).toContain(html);
  });

  it("forgets a document on unmount and on clear", () => {
    let n = 0;
    const mounts = new FrameMountRegistry({ newId: () => `m${n++}` });
    mounts.mount(request());
    mounts.mount(request());
    expect(mounts.size).toBe(2);
    expect(mounts.unmount("m0")).toBe(true);
    expect(mounts.unmount("m0")).toBe(false);
    expect(mounts.document("m0")).toBeUndefined();
    mounts.clear();
    expect(mounts.size).toBe(0);
  });

  it("serves a card mount at a host of its own, never under mount/", () => {
    const mounts = new FrameMountRegistry({ newId: () => "c1" });
    const script = "document.body.dataset.ran = '1';";
    const mount = mounts.mount(cardRequest(script));
    expect(mount).toEqual({ mountId: "c1", url: "app-frame://card-c1/" });
    expect(mounts.cardDocument("c1")?.csp).toBe(frameCsp([scriptHash(script)]));
    expect(mounts.cardDocument("c1")?.body).toContain(`<script>${script}</script>`);
    // Its page is born held: its own script waits until the card is shown (FI3-871).
    expect(mounts.cardDocument("c1")?.body).toContain('<html data-theme="dark" data-inf-held>');
    // The bridge is the only script the host adds.
    expect(mounts.cardDocument("c1")?.body.match(/<script>/g)).toHaveLength(2);
    // A card id never answers as a template, nor a template id as a card.
    expect(mounts.document("c1")).toBeUndefined();
    const other = new FrameMountRegistry({ newId: () => "t1" });
    other.mount(request(script));
    expect(other.cardDocument("t1")).toBeUndefined();
  });

  it("gives every mount a random, unguessable id", () => {
    const mounts = new FrameMountRegistry();
    const ids = [
      mounts.mount(cardRequest("1;")).mountId,
      mounts.mount(cardRequest("1;")).mountId,
      mounts.mount(request()).mountId,
    ];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("caps card mounts on their own, so cards never crowd out templates", () => {
    let n = 0;
    const mounts = new FrameMountRegistry({ cap: 2, cardCap: 1, newId: () => `m${n++}` });
    mounts.mount(cardRequest("1;"));
    expect(() => mounts.mount(cardRequest("1;"))).toThrow("already serves 1 card mounts");
    mounts.mount(request());
    mounts.mount(request());
    expect(() => mounts.mount(request())).toThrow("already serves 2 mounts");
    expect(mounts.unmount("m0")).toBe(true);
    // A refused mount never drew an id, so the next card is m3.
    expect(mounts.mount(cardRequest("1;")).url).toBe("app-frame://card-m3/");
    expect(CARD_MOUNT_CAP).toBe(8);
  });
});

describe("the frame scheme handler", () => {
  const fonts = { "ui-latin.woff2": "/fonts/ui-latin.woff2" };
  const pictures = () => ({ root: "/user/crewmates" });
  const picture = "t1-0123456789abcdef0123456789abcdef";
  const files: Record<string, Uint8Array> = {
    "/fonts/ui-latin.woff2": new Uint8Array([1, 2, 3]),
    [`/user/crewmates/t1/cards/${picture}.png`]: new Uint8Array([4, 5]),
    [`/user/crewmates/t1/cards/${picture}.jpg`]: new Uint8Array([6]),
    [`/user/crewmates/t1/cards/${picture}.webp`]: new Uint8Array([7]),
    "/user/crewmates/t1/sessions/session.jsonl": new Uint8Array([8]),
  };
  const read = async (path: string) => {
    const bytes = files[path];
    if (!bytes) throw new Error("missing");
    return bytes;
  };

  it("answers a mount with the document and the CSP as a header", async () => {
    const mounts = new FrameMountRegistry({ newId: () => "abc" });
    mounts.mount(request("1;"));
    const response = await answerFrameRequest(
      "app-frame://mount/abc",
      { mounts, fonts, pictures },
      read,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(mounts.document("abc")?.csp);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(mounts.document("abc")?.body);
  });

  it("answers a card mount only at its own host root", async () => {
    const mounts = new FrameMountRegistry({ newId: () => "card1" });
    mounts.mount(cardRequest("1;"));
    const response = await answerFrameRequest(
      "app-frame://card-card1/",
      { mounts, fonts, pictures },
      read,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(mounts.cardDocument("card1")?.csp);
    expect(await response.text()).toBe(mounts.cardDocument("card1")?.body);
    for (const url of [
      "app-frame://card-card1/extra",
      "app-frame://mount/card1",
      "app-frame://mount/card/card1",
      "app-frame://card-other/",
    ]) {
      expect((await answerFrameRequest(url, { mounts, fonts, pictures }, read)).status, url).toBe(
        404,
      );
    }
  });

  it("serves only the fonts it was given, with CORS for opaque-origin frames", async () => {
    const mounts = new FrameMountRegistry();
    const font = await answerFrameRequest(
      "app-frame://fonts/ui-latin.woff2",
      { mounts, fonts, pictures },
      read,
    );
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("access-control-allow-origin")).toBe("*");
    expect(new Uint8Array(await font.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    for (const url of [
      "app-frame://fonts/other.woff2",
      "app-frame://fonts/ui-latin.woff2/extra",
      "app-frame://fonts/constructor",
      "app-frame://mount/nope",
      "app-frame://elsewhere/x",
      "not a url",
    ]) {
      const response = await answerFrameRequest(url, { mounts, fonts, pictures }, read);
      expect(response.status, url).toBeGreaterThanOrEqual(400);
    }
  });

  it("serves a card picture by its minted name, typed by its format, and nothing else", async () => {
    const mounts = new FrameMountRegistry();
    for (const [extension, type, bytes] of [
      ["png", "image/png", [4, 5]],
      ["jpg", "image/jpeg", [6]],
      ["webp", "image/webp", [7]],
    ] as const) {
      const response = await answerFrameRequest(
        `app-frame://images/${picture}.${extension}`,
        { mounts, fonts, pictures },
        read,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
    }
    for (const url of [
      // Another task's folder, a traversal, a listing, a format it never mints.
      `app-frame://images/t2-0123456789abcdef0123456789abcdef.png`,
      "app-frame://images/..%2Fsessions%2Fsession.jsonl",
      "app-frame://images/t1/sessions/session.jsonl",
      "app-frame://images/",
      `app-frame://images/${picture}.gif`,
      `app-frame://images/${picture}.png/extra`,
      "app-frame://images/t1-0123.png",
    ]) {
      const response = await answerFrameRequest(url, { mounts, fonts, pictures }, read);
      expect(response.status, url).toBe(404);
    }
  });
});

// INF-128's plan, approved by the captain: the typefaces host serves only the
// host's kept copies of project fonts, with CORS for opaque-origin frames.
describe("the frame scheme's project fonts", () => {
  const typeface = "t1-0123456789abcdef0123456789abcdef";
  const hosts = (pictures: () => PictureSource) => ({
    mounts: new FrameMountRegistry(),
    fonts: {},
    pictures,
  });

  it("serves a kept font by its minted name, typed by its kind, to GET alone", async () => {
    const root = scratchDir("fm-frame-typefaces-");
    await mkdir(join(root, "t1", "cards"), { recursive: true });
    const bytes = projectFontBytes();
    await writeFile(join(root, "t1", "cards", `${typeface}.woff2`), bytes);
    await writeFile(join(root, "t1", "cards", `${typeface}.otf`), bytes);
    await writeFile(join(root, "t1", "cards", `${typeface}.png`), bytes);
    const at = hosts(() => ({ root }));

    const served = await answerFrameRequest(`app-frame://typefaces/${typeface}.woff2`, at);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("font/woff2");
    expect(served.headers.get("content-length")).toBe(String(bytes.length));
    expect(served.headers.get("access-control-allow-origin")).toBe("*");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expectBytesEqual(new Uint8Array(await served.arrayBuffer()), bytes);
    const otf = await answerFrameRequest(`app-frame://typefaces/${typeface}.otf`, at);
    expect(otf.headers.get("content-type")).toBe("font/otf");

    for (const url of [
      // Another task's folder, a traversal, a listing, a kind it never mints,
      // a picture's name, and a font's name at the pictures' host.
      "app-frame://typefaces/t2-0123456789abcdef0123456789abcdef.woff2",
      "app-frame://typefaces/..%2Fsessions%2Fsession.jsonl",
      "app-frame://typefaces/t1/cards/x.woff2",
      "app-frame://typefaces/",
      `app-frame://typefaces/${typeface}.ttc`,
      `app-frame://typefaces/${typeface}.png`,
      `app-frame://typefaces/${typeface}.woff2/extra`,
      `app-frame://images/${typeface}.woff2`,
    ]) {
      expect((await answerFrameRequest(url, at)).status, url).toBe(404);
    }
    const post = await answerFrameRequest(
      `app-frame://typefaces/${typeface}.woff2`,
      at,
      undefined,
      {
        method: "POST",
      },
    );
    expect(post.status).toBe(404);
  });

  it("asks the other Mac for a font a view's frame draws, and serves none where it cannot ask", async () => {
    const bytes = projectFontBytes();
    const asked: string[] = [];
    const view = hosts(() => ({
      fetch: async () => {
        throw new Error("not a picture");
      },
      fetchTypeface: async (fileName) => {
        asked.push(fileName);
        return bytes;
      },
    }));
    const served = await answerFrameRequest(`app-frame://typefaces/${typeface}.woff2`, view);
    expect(served.status).toBe(200);
    expect(served.headers.get("access-control-allow-origin")).toBe("*");
    expectBytesEqual(new Uint8Array(await served.arrayBuffer()), bytes);
    expect(asked).toEqual([`${typeface}.woff2`]);

    const older = hosts(() => ({ fetch: async () => bytes }));
    expect(
      (await answerFrameRequest(`app-frame://typefaces/${typeface}.woff2`, older)).status,
    ).toBe(404);
  });
});

describe("the frame scheme's demo recordings", () => {
  const recording = "t1-0123456789abcdef0123456789abcdef";
  const bytes = Uint8Array.from({ length: 3000 }, (_, index) => index % 251);
  const hosts = (pictures: () => PictureSource) => ({
    mounts: new FrameMountRegistry(),
    fonts: {},
    pictures,
  });

  async function localRoot(): Promise<string> {
    const root = scratchDir("fm-frame-media-");
    await mkdir(join(root, "t1", "cards"), { recursive: true });
    await writeFile(join(root, "t1", "cards", `${recording}.mp4`), bytes);
    return root;
  }

  it("streams a minted recording from its task's folder, a range at a time, typed and never sniffed", async () => {
    const root = await localRoot();
    const at = hosts(() => ({ root }));
    const url = `app-frame://media/${recording}.mp4`;
    const whole = await answerFrameRequest(url, at, undefined, { method: "GET" });
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("x-content-type-options")).toBe("nosniff");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytes);

    const part = await answerFrameRequest(url, at, undefined, {
      method: "GET",
      range: "bytes=1000-1499",
    });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 1000-1499/3000");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(1000, 1500));

    const past = await answerFrameRequest(url, at, undefined, {
      method: "GET",
      range: "bytes=3000-",
    });
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */3000");
  });

  it("serves nothing but a minted recording, and only to a read", async () => {
    const root = await localRoot();
    const at = hosts(() => ({ root }));
    for (const url of [
      `app-frame://media/t2-0123456789abcdef0123456789abcdef.mp4`,
      `app-frame://media/${recording}.png`,
      `app-frame://images/${recording}.mp4`,
      "app-frame://media/..%2F..%2Fsessions%2Fsession.jsonl",
      "app-frame://media/",
      `app-frame://media/${recording}.mp4/extra`,
    ]) {
      expect((await answerFrameRequest(url, at)).status, url).toBe(404);
    }
    const post = await answerFrameRequest(`app-frame://media/${recording}.mp4`, at, undefined, {
      method: "POST",
    });
    expect(post.status).toBe(405);
  });

  it("asks another Mac for a range one piece at a time, learning the size once", async () => {
    const asked: [number, number][] = [];
    const big = Uint8Array.from({ length: MEDIA_PIECE_BYTES + 500 }, (_, index) => index % 7);
    const at = hosts(() => ({
      fetch: async () => new Uint8Array(),
      fetchMedia: async (_name: string, offset: number, length: number) => {
        asked.push([offset, length]);
        return { data: big.slice(offset, offset + length), size: big.length };
      },
    }));
    const name = "t1-fedcba9876543210fedcba9876543210";
    const url = `app-frame://media/${name}.mp4`;
    const first = await answerFrameRequest(url, at, undefined, {
      method: "GET",
      range: "bytes=0-",
    });
    expect(first.status).toBe(206);
    expect(first.headers.get("content-range")).toBe(
      `bytes 0-${MEDIA_PIECE_BYTES - 1}/${big.length}`,
    );
    expectBytesEqual(new Uint8Array(await first.arrayBuffer()), big.subarray(0, MEDIA_PIECE_BYTES));
    const rest = await answerFrameRequest(url, at, undefined, {
      method: "GET",
      range: `bytes=${MEDIA_PIECE_BYTES}-`,
    });
    expectBytesEqual(new Uint8Array(await rest.arrayBuffer()), big.subarray(MEDIA_PIECE_BYTES));
    expect(asked).toEqual([
      [0, 0],
      [0, MEDIA_PIECE_BYTES],
      [MEDIA_PIECE_BYTES, 500],
    ]);
  });
});
