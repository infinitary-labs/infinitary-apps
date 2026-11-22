import { TYPEFACE_UNREAD_WORDS } from "../../../src/core/pi/cardImages";
import { damagedFontBytes, projectFontBytes } from "../../helpers/fontFixture";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { shellJobsRunning } from "../browserScript";
import { INLINE_PNG, writeFilesCalls } from "../crewCards";
import { CARD_FETCH_PROBE_PATH, type Scenario } from "../mockProvider";
import { calledTool, providerMessages } from "../providerRequest";

/**
 * Marker prompt: the mock crewmate emits the containment corpus - every
 * attack vector the retired sanitizer used to strip, in one body per
 * vehicle. There is no sanitizer any more (captain decision, 2026-09-15):
 * the frame's sandbox, its CSP and the host's bridge validation are the
 * boundary, and `tests/e2e/card-containment.spec.ts` measures them.
 */
export const ATTACK_CARDS_PROMPT_MARKER = "show the containment corpus";

export const ATTACK_CARD_TITLES = {
  /** No `<script>` element, so this body rides srcdoc. */
  srcdoc: "Containment corpus",
  /** Carries scripts, so the host serves it as a card mount. */
  mount: "Containment corpus with scripts",
  /** A `data:` image, the one thing a frame may now load (captain decision). */
  image: "Inline image",
  /** Navigation of the frame away from its own document: a self-inflicted nuisance. */
  selfNav: "Navigating away",
} as const;

/** Any vector that executes sets this on the frame's window; none may. */
export const ATTACK_MARKER = "fmAttackRan";

/**
 * Every vector that needs no `<script>` element of its own: event handler
 * attributes, `javascript:` URLs, and every element that names a resource.
 * Each URL aims at the mock server's probe path, which counts what arrives.
 */
function scriptlessAttackBody(probe: string): string {
  const M = ATTACK_MARKER;
  const fire = `window.${M} = true`;
  return (
    `<p onclick="${fire}" onmouseover="${fire}">Every vector the sanitizer used to strip.</p>` +
    `<div onload="${fire}" onerror="${fire}" onfocus="${fire}" onanimationstart="${fire}"></div>` +
    `<details ontoggle="${fire}"><summary onfocus="${fire}">Evidence</summary>` +
    `<a href="javascript:${fire}">a javascript URL</a>` +
    `<a href="${probe}?anchor" download="x.txt">a download</a></details>` +
    `<img src="${probe}?img" onerror="${fire}" alt="">` +
    `<iframe src="${probe}?iframe"></iframe>` +
    `<object data="${probe}?object"></object><embed src="${probe}?embed">` +
    `<link rel="stylesheet" href="${probe}?link">` +
    `<style>@import url(${probe}?import);.x{background-image:url(${probe}?css)}</style>` +
    `<base href="${probe}/">` +
    `<form action="${probe}?form" method="post"><button type="submit">Submit</button></form>` +
    `<video src="${probe}?video" autoplay><source src="${probe}?source"></video>` +
    `<audio src="${probe}?audio" autoplay></audio>` +
    `<svg><image href="${probe}?svgimage"></image>` +
    `<use href="${probe}?use#icon"></use>` +
    `<a href="javascript:${fire}"><text>svg link</text></a>` +
    `<set attributeName="href" to="javascript:${fire}"></set>` +
    `<foreignObject width="80" height="20"><iframe src="${probe}?fo"></iframe></foreignObject>` +
    "</svg>"
  );
}

/**
 * The same corpus on the mount vehicle, plus the two vectors that need a
 * script element: a `<script src>` the CSP must refuse, and a script the
 * card injects at run time, which has no hash. The card's OWN inline script
 * runs by design (WI-16) and is what reports both verdicts.
 */
function scriptedAttackBody(probe: string): string {
  const M = ATTACK_MARKER;
  return (
    scriptlessAttackBody(probe) +
    `<p role="status">pending</p>` +
    `<script src="${probe}?scriptsrc"></script>` +
    "<script>(function () {" +
    `var injected = document.createElement("script");` +
    `injected.textContent = "window.${M} = true;";` +
    "document.body.appendChild(injected);" +
    `var img = new Image(); img.src = ${JSON.stringify(`${probe}?runtimeimg`)};` +
    `fetch(${JSON.stringify(`${probe}?fetch`)}).catch(function () {});` +
    `try { new WebSocket(${JSON.stringify(probe.replace("http://", "ws://"))}); } catch (e) {}` +
    `try { navigator.sendBeacon(${JSON.stringify(`${probe}?beacon`)}); } catch (e) {}` +
    `document.querySelector("[role=status]").textContent = "ran";` +
    "})();</script>"
  );
}

function attackCardToolCalls(port: number): ScriptedCall[] {
  const probe = `http://127.0.0.1:${port}${CARD_FETCH_PROBE_PATH}`;
  return [
    {
      name: "emit_card",
      args: { title: ATTACK_CARD_TITLES.srcdoc, body: scriptlessAttackBody(probe) },
    },
    {
      name: "emit_card",
      args: { title: ATTACK_CARD_TITLES.mount, body: scriptedAttackBody(probe) },
    },
    {
      name: "emit_card",
      args: {
        title: ATTACK_CARD_TITLES.image,
        body: `<p>An image the body carries itself.</p><img src="${INLINE_PNG}" width="2" height="2" alt="">`,
      },
    },
    {
      name: "emit_card",
      args: {
        title: ATTACK_CARD_TITLES.selfNav,
        body:
          `<p>This body navigates its own frame.</p>` +
          `<meta http-equiv="refresh" content="0;url=${probe}?meta">`,
      },
    },
  ];
}

/**
 * Marker prompt (project fonts, `tests/e2e/card-containment.spec.ts`): the
 * mock crewmate writes its project's own font file into its working copy,
 * beside a copy damaged inside its compressed data, and names one in a
 * preview's `@font-face`. It offers the preview with the damaged copy first
 * - which the host's test load refuses - then, reading the refusal, with
 * the real file. The same preview names a second face by a web address,
 * first in its family list, which no frame loads.
 */
export const PROJECT_FONT_PROMPT_MARKER = "show the project font";

export const PROJECT_FONT_CARD_TITLE = "The balance screen in the project's own type";

/** The family the preview's `@font-face` names the project's file by. */
export const PROJECT_FONT_FAMILY = "Project Face";

export const PROJECT_FONT_REFUSAL = TYPEFACE_UNREAD_WORDS;

export const PROJECT_FONTS_STILL_WRITING = "The font files are still being written.";

const PROJECT_FONT = "shots/project-face.woff2";

const DAMAGED_FONT = "shots/project-face-damaged.woff2";

function writeProjectFontCalls(): ScriptedCall[] {
  return writeFilesCalls([
    { path: PROJECT_FONT, bytes: projectFontBytes() },
    { path: DAMAGED_FONT, bytes: damagedFontBytes() },
  ]);
}

function projectFontCardCall(font: string, port: number): ScriptedCall {
  const probe = `http://127.0.0.1:${port}${CARD_FETCH_PROBE_PATH}`;
  return {
    name: "emit_card",
    args: {
      title: PROJECT_FONT_CARD_TITLE,
      body:
        "<p>The balance screen, drawn in the project's own type.</p>" +
        "<style>" +
        `@font-face{font-family:"${PROJECT_FONT_FAMILY}";font-weight:300 700;src:url("${font}") format("woff2")}` +
        `@font-face{font-family:"Web Face";src:url("${probe}?font") format("woff2")}` +
        // The web face comes first, so the frame tries it - and loads nothing - before the project's.
        `.balance{font-family:"Web Face","${PROJECT_FONT_FAMILY}",sans-serif;background:#fbf4e6;color:#1d2a24;border-radius:16px;padding:16px 20px;max-width:320px}` +
        ".balance h2{margin:0 0 6px;font-size:22px;font-weight:700;color:#1d2a24}.balance p{margin:0;color:#1d2a24}" +
        ".balance .amount{font-size:40px;font-weight:700}" +
        "</style>" +
        `<div class="balance"><h2>Harbor Ledger</h2><p>Balance</p><p class="amount">$42.50</p><p>Saving for a bike - 3 weeks to go</p></div>`,
    },
  };
}

/**
 * The containment corpus: cards that try to escape their frame, and a
 * crewmate whose preview loads the project's own font, first from a damaged
 * copy the host refuses.
 */
export const cardContainment: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults, port }) => {
    // The first mate commissions the crewmate through the shared stand-in.
    if (isFirstmate) return undefined;
    if (latestUserTail.includes(ATTACK_CARDS_PROMPT_MARKER) && !hasToolResults && wantsStream) {
      return { calls: attackCardToolCalls(port) };
    }
    // The project-font crewmate: write the files, offer the preview with
    // the damaged copy, then with the real file once the host refused it.
    // It reads the whole conversation, not only its latest turn, because a
    // write can resume it from a wake.
    if (body.includes(PROJECT_FONT_PROMPT_MARKER) && wantsStream) {
      if (!calledTool(body, "bash")) {
        return { calls: writeProjectFontCalls() };
      }
      // INF-2029: a write that outlasts the shell's limit answers with its
      // job's receipt while the file is still being written, and a card
      // naming it would be refused as missing. End the turn until every
      // write's job has exited (as INF-1128 did for pictures).
      if (shellJobsRunning(body)) return { text: PROJECT_FONTS_STILL_WRITING };
      if (!calledTool(body, "emit_card")) {
        return { calls: [projectFontCardCall(DAMAGED_FONT, port)] };
      }
      const emits = ['"name":"emit_card","arguments"', '"name": "emit_card", "arguments"']
        .map((call) => body.split(call).length - 1)
        .reduce((sum, count) => sum + count, 0);
      // A refusal of the damaged copy names it - unreadable, or missing -
      // where a shown card answers with its title only.
      const answers = providerMessages(body).filter((message) => message.role === "tool");
      if (emits === 1 && answers.at(-1)?.text.includes(DAMAGED_FONT)) {
        return { calls: [projectFontCardCall(PROJECT_FONT, port)] };
      }
    }
    return undefined;
  };
