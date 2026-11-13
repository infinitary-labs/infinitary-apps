import { CARD_QUESTION_LABEL_MAX, CARD_QUESTIONS_MAX_BYTES, CARD_WRITTEN_MAX } from "../cards";
import { OWN_SPELLING, SPELLINGS } from "../codeNames";
import { TYPING_CONTROL_SELECTOR } from "../keyboardOffer";
import { KNOWLEDGE_ID_IN_TEXT } from "../knowledge";
import { TASK_KEY_IN_TEXT } from "../taskKeys";
import {
  AS_BUILT_WORDS,
  DRAWING_LOOK,
  DRAWING_SOURCE_PREFIX,
  DRAWING_WORDS_LOOK,
  FRAME_BRIDGE_VERSION,
  FRAME_DEMO_CAPTION_MAX,
  FRAME_DEMO_SOURCE,
  FRAME_PICTURE_ALT_MAX,
  PICTURE_STRIP_SHOWN,
} from "./bridge";
import { FRAME_ANNOTATION_SCRIPT } from "./frameAnnotationScript";
import { READ_VALUE_DECODER } from "./readTransfer";

/**
 * Bridge v2: the one app-owned script every plugin frame runs (phase 1 of
 * the UI plugin system, docs/ui-plugins.md). It is the direct descendant of
 * the D-9 card-body bridge and replaces it for every frame the host opens -
 * card bodies (srcdoc) and template mounts (the app-frame vehicle) alike.
 *
 * Inside the frame it exposes exactly `window.inf` and nothing more - the
 * same bridge also as `window.fm`, Firstmate 3000's name for it, which a
 * card or panel written before the Infinitary rename calls:
 *
 * - `inf.subscribe(read, args, onValue, onError?)` - a read-catalog
 *   subscription. The host executes the read, pushes the first value and
 *   every later one as `data` messages (a failed re-read reaches `onError`
 *   the same way), and answers the request once the subscription is
 *   accepted. The frame never holds IPC and never composes a query: `read`
 *   must be a name the plugin declared and `args` must parse against the
 *   catalog's own schema.
 * - `inf.action(id, value?)` - a declared action, optionally with a bounded
 *   value.
 * - `inf.fetch(alias, request)` - a mediated outbound request. Async and
 *   correlated from birth (proposal section 7.5): the host answers it, and
 *   until a grant is served (phase 3) the answer is a refusal.
 * - `inf.theme` / `inf.onTheme(cb)` - theme as data, not a rebuild; the bridge
 *   applies `data-theme` itself so token CSS follows without template code.
 * - `inf.store(request)` / `inf.onStore(cb)` - the panel's own slice of the
 *   extension store (one plugin vehicle, Phase A item 4: an added panel's
 *   `PanelProps.store` in the frame realm). The request names an operation
 *   and a key, never whose slice: the host binds the slice to the mount, so
 *   a frame can reach its own and no other, and refuses the verb on a mount
 *   it bound none to. `onStore` hears each key of that slice that changed.
 * - `data-width` on the document - the card's shown size (`regular`, `wide`
 *   or `full`), pushed by the host after `ready` and again when the card is
 *   resized, so a body can style for the room it has. Only a card's frame
 *   is told one; a told frame also caps every `width="100%"` drawing at its
 *   own viewBox width in px - then and whenever the document resizes - so a
 *   510-unit drawing draws at 1:1 in a wide card instead of growing with it
 *   (the captain's Q7 A of 2026-09-28).
 * - `inf.state` / `inf.onState(cb)` - VIEW state the host pushes down, the one
 *   channel that runs host to frame without a read behind it (the now
 *   panel's selected row, task-system P4): the shell owns which row is
 *   open, because it owns the pane docked beside it, and a panel cannot
 *   learn that from the core. It is not app data - it is never persisted,
 *   never invalidated, and a frame that ignores it loses nothing - so it
 *   rides the theme's shape rather than the read catalog's.
 *   `inf.birthState` keeps the state the host pushed at the document's
 *   birth, which later pushes never replace, so a page that starts reading
 *   late can still tell what the host pushed after it was born.
 * - `inf.stage(name, value)` - a JSON snapshot staged under a name beside the
 *   body's own form (inline decisions, contract 4.22). It is local: it joins
 *   the form's answers and leaves the card only with them.
 *
 * A card body's FORM is the bridge's to watch (inline decisions, contract
 * 4.22; docs/card-authoring.md "Questions in the body"). Once the host says
 * so - a `form` message, which only a card mount sends - the bridge reads
 * every named control (radios, checkboxes, a `<select>`, a `<textarea>`, a
 * text or hidden field) on each `input` and `change` and on each change to
 * the document, and posts the one-way `answers` message: how many named
 * questions there are (`of`), how many are answered (non-empty, or not
 * `required`), how many differ from the state the author wrote (`changed`:
 * `defaultChecked`, `defaultValue`, the `selected` option, a hidden field's
 * first value), and the answers themselves, which are only the shell's
 * draft. A pick sends nothing to the author: only a footer button does,
 * after it asks the bridge for a fresh reading (`collect`), and the host
 * bounds what it sends. The `form` message carries the shell's draft back
 * to every new document of the card, which the bridge reapplies by name
 * where the captain changed a pick, so a pick survives a revision that
 * keeps its question and a renamed question starts fresh. A question's
 * Something else row (`data-inf-write-in`, FI3-1002) is never an option
 * value: while it is picked the bridge shows a text field of its own under
 * it and reads the words as the answer's `written`. A question marked
 * `data-inf-options-only` has no row; the mark is for the card lint, and the
 * bridge draws nothing for it.
 *
 * Every verb is request/response with a correlation id, so a verb added
 * later is an addition to the same envelope rather than a new bridge and a
 * re-versioned template set. `resize` carries the body's exact height - a
 * host rounds it as its layout needs (a card body up to a whole pixel, a
 * panel in the frame realm not at all, so it lays out exactly as the same
 * panel does in the app's window). `resize` and `link` are one-way notifications
 * kept from v1; `data-inf-action` clicks and `window.infAction` (and
 * Firstmate 3000's `data-fm-action` and `window.fmAction`) stay for the
 * agent-authored card bodies that already use them. `image` is their
 * sibling (card pictures, phase 3 of the locked plan): a click on ANY
 * `<img>` posts the clicked index and the pictures of its group - the
 * `figure.inf-pictures` it is a direct child of, else the picture alone -
 * each with its src, alt and natural size, so the host can open the picture
 * viewer with no code in the body. A click on a diagram - the outermost
 * inline drawing in a figure, or one drawn the width of what holds it - or
 * Enter or Space on one, posts the same message with one picture: the
 * drawing as it stands, its look written on each element, as an SVG picture
 * the host shows like any other (INF-3107). A click on a group's "+N" tile (the
 * figure's `::after`, laid out by the frame stylesheet beside the last
 * thumbnail or on the line under it) opens the group at the first picture
 * the strip does not show. A picture inside a control - a link, a button, a
 * summary, a label, a `data-inf-action` element - is that control's, and a
 * body script that already handled the click (`preventDefault`) keeps it.
 * `demo` is the picture's twin for a demo recording (docs/card-authoring.md
 * "Demo recordings"): the bridge draws a Play button with the recording's
 * length under each `figure[data-inf-demo]` poster the host verified, and a
 * click on it - or on the poster, which opens it paused - posts the
 * recording's served name, the poster, the caption and whether to play, so
 * the host plays it in the picture viewer. The body itself never loads the
 * recording: its policy loads no media. `draft` is the link's sibling for
 * the app's own message box (FI3-1164): a click on a `data-inf-draft`
 * control - a starter on the welcome - posts its words, one line, which the
 * host puts at the start of the message box, caret after them, sending
 * nothing, and only from a frame that holds the window's focus, as a link
 * opens only then. `ping` / `pong` is the
 * host's liveness probe (the frame watchdog, WI-16): the bridge answers every
 * ping from its message listener, so a frame whose event loop is wedged by a
 * runaway script stops answering and the host tears it down.
 *
 * A card body's TASK KEYS are the bridge's to link (FI3-594, FI3-1271; the
 * design skill's core rule "Task keys"). The host scans the body - or a
 * task's record, its read - for text shaped like a key, finds which are
 * recorded tasks, a record's own task aside, and tells the document those -
 * a `tasks` message, which only a card or a record mount sends. The bridge
 * wraps each one where text writes it, outside links, controls (a toggle's
 * summary, a role=button element and a draft button among them), scripts,
 * styles and drawings - but inside a choice's label, whose click on the key
 * opens the task and leaves the choice as it was (INF-3945) - in `<a data-inf-task>` (role link, in the
 * tab order), again whenever the document changes, and posts the one-way
 * `task` message: `rest` with the key's box when the pointer lands on one,
 * `leave` when it goes or on a press, Esc or a scroll (after a press or Esc,
 * the same key rests again only once the pointer has left it), and `open`
 * on a click or Enter. The keyboard rests on a key as the pointer does: a
 * key the keyboard moves focus to posts `rest` once the window has brought
 * it into view, and losing focus posts `leave`. Linking moves no text, so it
 * is not a live change. The host also tells the document which of its keys a
 * rest elsewhere in the window lights - a Tasks row, a crewmate, another
 * key (INF-237) - in a `lit` message with the key or null: the bridge marks
 * `data-inf-lit` on every link to that key, again on links it makes later,
 * and the frame stylesheet draws it as the hover mark. Marking moves no
 * text either.
 *
 * Its KNOWLEDGE REFERENCES are linked the same way (docs/knowledge.md,
 * "References in an answer"): the host tells the document which entry ids
 * the body writes name entries the window reads - an `entries` message,
 * with the words each reference is read by and the mark its standing takes
 * - and the bridge wraps each where text writes it in `<a data-inf-entry>`
 * (role link, in the tab order), and posts the one-way `entry` message on a
 * click or Enter. A reference only opens: it has no rest.
 *
 * A card body's KEYBOARD is the bridge's to complete (FI3-800 piece 6;
 * docs/keyboard.md, "Cards and frames"). Once the host says which of its
 * keys it hears - a `keys` message - the bridge makes each picture a click
 * would open a Tab stop (`data-inf-picture`; it stays an image, named by its
 * alt) that Enter or Space opens as the click does, and an Escape nothing in the body used (no open
 * dialog or popover, no search field it clears, not a held key, not the Esc
 * that let a task key go) posts the one-way `escape`, which the host takes
 * as leaving the body for its card. The bridge remembers the element that
 * last had focus in its document, and the caret of a text field, until a
 * press elsewhere in the body; the host's `focus` message, sent right after
 * the host gave the frame focus back (command search or the picture viewer
 * closed), puts focus back on it. None of these can do more than move
 * focus: what a gesture opens is the host's call, and the host counts one
 * only from a frame that holds the window's focus.
 *
 * The one-way `focused` says when the frame's own window gains or loses the
 * window's focus, which the window's page does not hear when focus moves
 * straight from one frame to another (docs/ui-plugins.md, "Focus and the
 * frames"). The bridge hears it before any script of the body's and sends
 * it through what it held from its start, so the body cannot keep its frame
 * from saying it. The one-way `pressed` says, the same way, that a press
 * began in the frame's window - a pointer going down, or a key that is not
 * a held key repeating - which the window's page does not hear either: a
 * card the captain pointed at before it takes focus only if he began no
 * press since (docs/keyboard.md, "Cards and frames").
 *
 * A document's MARKUP can be refreshed in place (FI3-1093): the host's
 * `markup` message carries the body's markup anew, and the bridge rewrites
 * only what differs from the document - an attribute, a text, an element
 * that is not the one in its place - so every node that did not change is
 * the same node afterwards. A press on a link that the refresh leaves
 * alone is still on that link when the button comes up, where a new
 * document would have lost the click. Only the host's own fact strip asks
 * for it (`FrameMountSpec.markup`); a card body is still a new document per
 * revision. Before DOMContentLoaded, only the latest refresh is kept:
 * morphing a document still being parsed would let the parser append its
 * remaining nodes a second time. The parsed markup is inert: nothing runs.
 *
 * A card's page is born HELD (FI3-871; docs/renderer.md, "Held
 * preparation"), so the stage can prepare the next card before it is shown
 * without any of the card's own behavior starting unseen. Its builder marks
 * the document (`data-inf-held`, which the bridge reads and removes); the
 * markup, styles, fonts and pictures load as ever, while every `<script>`
 * the parser inserts is held before it can run (its `type` changed in a
 * mutation record, which the parser delivers before it runs a script), CSS
 * animations are paused by one rule, and each SVG timeline is paused. The
 * host's `activate` - sent when the card is shown, at once for a card loaded
 * on demand - releases the page once its markup is read: each held script
 * is put back in order under the same hash, so it runs as if deferred;
 * `DOMContentLoaded` and `load` listeners those scripts add are run once;
 * animations resume; the form starts, so its baseline is what the body
 * shows after its scripts; and the drawing is reported at once, held or
 * not, without waiting for a frame. A released script runs only by its own
 * hash, exactly as it would have: the policy has no `'strict-dynamic'`. A
 * panel's document is never marked, so nothing in it is held.
 *
 * `ready` is posted the moment the bridge is installed - before any
 * template script can run, so it marks the BIRTH of a document: every
 * request the document ever makes follows its own `ready`, and the host
 * treats a second `ready` from the same frame as a new document (a card
 * body rebuilt) whose predecessor's subscriptions are void. Each document
 * numbers its requests from 1, so a `response` names the document that
 * asked, and a document ignores one that names another.
 *
 * The script executes by SHA-256 hash alone (`FRAME_BRIDGE_SHA256` rides
 * both the app CSP and every frame CSP). Change the text and the hash must
 * change with it - `src/main/security/frameBridgeHash.test.ts` pins the pair.
 */

export const FRAME_BRIDGE_SCRIPT = `(function () {
  var VERSION = ${FRAME_BRIDGE_VERSION};
  var LABEL_MAX = ${CARD_QUESTION_LABEL_MAX};
  var QUESTIONS_MAX_BYTES = ${CARD_QUESTIONS_MAX_BYTES};
  var WRITTEN_MAX = ${CARD_WRITTEN_MAX};
  ${FRAME_ANNOTATION_SCRIPT}
  var nextId = 1;
  var pending = {};
  var subscriptions = {};
  var receiveReadValue = ${READ_VALUE_DECODER};
  var themeListeners = [];
  var stateListeners = [];
  var storeListeners = [];
  var state = null;
  var birthState = null;
  var stateSeen = false;
  var sized = false;
  var initialized = false;
  var documentId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  var capped = new WeakSet();
  var theme = document.documentElement.getAttribute("data-theme") || "dark";
  var form = { on: false, locked: false, fill: null, filling: false, staged: {}, first: new WeakMap(), last: "", fields: new WeakMap() };
  var KEY_IN_TEXT = new RegExp(${JSON.stringify(`${TASK_KEY_IN_TEXT}|${KNOWLEDGE_ID_IN_TEXT}`)}, "g");
  var UNLINKED = "a, button, summary, input, select, option, textarea, script, style, svg, [role=button], [data-inf-action], [data-inf-draft], [contenteditable]";
  var keys = { known: null, rested: null, quiet: null, lit: null };
  var entries = { known: null };
  var caps = { pictures: false, escape: false };
  var held = { element: null, start: null, end: null, direction: null };
  var listen = EventTarget.prototype.addEventListener;
  // A hook in another spelling of the app's code names - Firstmate 3000's
  // data-fm-action, fm-mono - reads as this build's own too, so a card
  // written before the Infinitary rename works here (src/shared/codeNames.ts). Every
  // element is read as it arrives and again as such an attribute changes; the
  // author's own attributes and classes stay as written.
  var OWN = ${JSON.stringify(OWN_SPELLING)};
  var OTHERS = ${JSON.stringify(SPELLINGS.filter((spelling) => spelling !== OWN_SPELLING))};
  function ownHook(name) {
    for (var i = 0; i < OTHERS.length; i++) {
      var prefix = "data-" + OTHERS[i] + "-";
      if (name.indexOf(prefix) === 0) return "data-" + OWN + "-" + name.slice(prefix.length);
    }
    return null;
  }
  function respell(element, changed) {
    if (!element || element.nodeType !== 1) return;
    var names = changed ? [changed] : Array.prototype.map.call(element.attributes, function (a) { return a.name; });
    names.forEach(function (name) {
      var own = ownHook(name);
      if (!own) return;
      // Written only when it differs: a write records a change even when the
      // value is the same, which would wake this observer again for ever.
      var value = element.getAttribute(name);
      if (value === null) {
        if (element.hasAttribute(own)) element.removeAttribute(own);
      } else if ((changed || !element.hasAttribute(own)) && element.getAttribute(own) !== value) {
        element.setAttribute(own, value);
      }
    });
    if (element.classList && (!changed || changed === "class")) {
      Array.prototype.slice.call(element.classList).forEach(function (token) {
        for (var i = 0; i < OTHERS.length; i++) {
          var mine = OWN + "-" + token.slice(OTHERS[i].length + 1);
          if (token.indexOf(OTHERS[i] + "-") === 0 && !element.classList.contains(mine)) element.classList.add(mine);
        }
      });
    }
  }
  function respellTree(node) {
    if (node.nodeType !== 1) return;
    respell(node);
    if (node.firstElementChild) Array.prototype.forEach.call(node.querySelectorAll("*"), function (child) { respell(child); });
  }
  respellTree(document.documentElement);
  new MutationObserver(function (records) {
    records.forEach(function (record) {
      if (record.type === "attributes") {
        if (record.attributeName === "class" || ownHook(record.attributeName)) respell(record.target, record.attributeName);
      } else {
        Array.prototype.forEach.call(record.addedNodes, respellTree);
      }
    });
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  var BRIDGE = document.currentScript;
  var SVG_NS = "http://www.w3.org/2000/svg";
  var hold = document.documentElement.hasAttribute("data-inf-held")
    ? { scripts: [], seen: new WeakSet(), timelines: [], watch: null, style: null, form: false, waiting: false }
    : null;
  document.documentElement.removeAttribute("data-inf-held");
  var loaded = false;
  var settling = false;
  window.addEventListener("load", function () { loaded = true; });
  function holdNodes(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.nodeType !== 1) continue;
      var found = node.localName === "script" || node.localName === "svg" ? [node] : [];
      if (node.firstElementChild) found = found.concat(Array.prototype.slice.call(node.querySelectorAll("script, svg")));
      found.forEach(function (element) {
        if (element.localName === "svg") {
          if (element.namespaceURI === SVG_NS && !element.ownerSVGElement && !element.animationsPaused()) {
            element.pauseAnimations();
            hold.timelines.push(element);
          }
          return;
        }
        if (element === BRIDGE || hold.seen.has(element)) return;
        hold.seen.add(element);
        hold.scripts.push({ element: element, type: element.getAttribute("type") });
        element.setAttribute("type", "text/inf-held");
      });
    }
  }
  if (hold) {
    hold.watch = new MutationObserver(function (records) {
      records.forEach(function (record) { holdNodes(record.addedNodes); });
    });
    hold.watch.observe(document.documentElement, { childList: true, subtree: true });
    hold.style = document.createElement("style");
    hold.style.textContent = "*, *::before, *::after { animation-play-state: paused !important; }";
    (document.head || document.documentElement).appendChild(hold.style);
  }
  // Released once the markup is read: at the end of DOMContentLoaded, so a
  // listener a released script adds for it is run here, once, and never by
  // the browser as well.
  function activate() {
    if (!hold || hold.waiting) return;
    if (document.readyState === "loading") {
      hold.waiting = true;
      window.addEventListener("DOMContentLoaded", release, { once: true });
      return;
    }
    release();
  }
  function release() {
    if (!hold) return;
    hold.watch.takeRecords().forEach(function (record) { holdNodes(record.addedNodes); });
    hold.watch.disconnect();
    var parts = hold;
    hold = null;
    parts.style.remove();
    parts.timelines.forEach(function (svg) { svg.unpauseAnimations(); });
    var late = { document: [], window: [], load: [] };
    var shims = [document, window].map(function (target) {
      var shim = function (type, listener, options) {
        if (listener && this === target) {
          if (type === "DOMContentLoaded") late[target === document ? "document" : "window"].push(listener);
          else if (type === "load" && target === window && loaded) late.load.push(listener);
        }
        return listen.call(this, type, listener, options);
      };
      target.addEventListener = shim;
      return { target: target, shim: shim };
    });
    var onload = window.onload;
    parts.scripts.forEach(function (entry) {
      var old = entry.element;
      if (!old.isConnected) return;
      var script = document.createElementNS(old.namespaceURI, "script");
      for (var i = 0; i < old.attributes.length; i++) {
        var attribute = old.attributes[i];
        if (attribute.name !== "type") script.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
      }
      if (entry.type !== null) script.setAttribute("type", entry.type);
      script.textContent = old.textContent;
      old.replaceWith(script);
    });
    shims.forEach(function (entry) {
      if (entry.target.addEventListener === entry.shim) delete entry.target.addEventListener;
    });
    var target = { document: document, window: window, load: window };
    ["document", "window", "load"].forEach(function (phase) {
      late[phase].forEach(function (listener) {
        var event = new Event(phase === "load" ? "load" : "DOMContentLoaded");
        try {
          if (typeof listener === "function") listener.call(target[phase], event);
          else if (typeof listener.handleEvent === "function") listener.handleEvent(event);
        } catch (error) {
          reportError(error);
        }
      });
    });
    if (loaded && window.onload !== onload && typeof window.onload === "function") {
      try { window.onload(new Event("load")); } catch (error) { reportError(error); }
    }
    // The form's baseline is what the body shows once its scripts have run.
    if (parts.form) startForm();
    // What the scripts do in their first two frames is the drawing settling, not a live change.
    settling = true;
    requestAnimationFrame(function () { requestAnimationFrame(function () { settling = false; }); });
    reportDrawing();
  }
  function capFigures() {
    if (!sized) return;
    var figures = document.querySelectorAll('svg[width="100%"]');
    for (var i = 0; i < figures.length; i++) {
      var figure = figures[i];
      if (figure.parentElement && figure.parentElement.closest("svg")) continue;
      if (figure.style.maxWidth && !capped.has(figure)) continue;
      var box = figure.viewBox && figure.viewBox.baseVal;
      if (!box || !(box.width > 0)) continue;
      var cap = box.width + "px";
      if (figure.style.maxWidth !== cap) figure.style.maxWidth = cap;
      capped.add(figure);
    }
  }
  // Resolves at a frame on which no font face is still loading: a face
  // still loading is awaited, and the next frame looks again.
  function fontsIn() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function look() {
        var loading = [];
        document.fonts.forEach(function (face) {
          if (face.status === "loading") loading.push(face.loaded.then(null, function () {}));
        });
        if (!loading.length) { resolve(); return; }
        Promise.all(loading).then(function () { requestAnimationFrame(look); });
      });
    });
  }
  function post(message) {
    message.fm = VERSION;
    message.document = documentId;
    parent.postMessage(message, "*");
  }
  var pendingMarkup;
  function refreshMarkup(html) {
    // The initial refresh can arrive before the original parser finishes.
    // Let it finish before morphing, including when no body exists yet.
    if (document.readyState === "loading") {
      pendingMarkup = html;
      return;
    }
    pendingMarkup = undefined;
    if (!document.body) return;
    var next = document.createElement("template");
    next.innerHTML = html;
    morphChildren(document.body, next.content);
  }
  document.addEventListener("DOMContentLoaded", function () {
    if (pendingMarkup === undefined) return;
    var html = pendingMarkup;
    pendingMarkup = undefined;
    refreshMarkup(html);
  }, { once: true });
  function blank(node) {
    return node.nodeType === 3 && node.nodeValue.trim() === "";
  }
  function morphChildren(into, from) {
    var at = into.firstChild;
    var source = from.firstChild;
    while (source) {
      var following = source.nextSibling;
      if (!at) {
        into.appendChild(source);
      } else if (at.nodeType === source.nodeType && at.nodeName === source.nodeName) {
        if (at.nodeType === 1) {
          morphAttributes(at, source);
          morphChildren(at, source);
        } else if (at.nodeValue !== source.nodeValue) {
          at.nodeValue = source.nodeValue;
        }
        at = at.nextSibling;
      } else if (blank(at)) {
        // Whitespace the document was written with goes, and the same
        // source meets the next node: the markup around it is not new.
        var gone = at;
        at = at.nextSibling;
        into.removeChild(gone);
        continue;
      } else if (blank(source)) {
        into.insertBefore(source, at);
      } else {
        var replaced = at;
        at = at.nextSibling;
        into.replaceChild(source, replaced);
      }
      source = following;
    }
    while (at) {
      var rest = at.nextSibling;
      into.removeChild(at);
      at = rest;
    }
  }
  function morphAttributes(element, source) {
    var i;
    for (i = element.attributes.length - 1; i >= 0; i--) {
      var name = element.attributes[i].name;
      // A reader owns a keyed disclosure's open state through live refreshes.
      // A new identity (for example a changed version or evidence) resets it.
      if (name === "open" && element.tagName === "DETAILS" &&
          element.hasAttribute("data-inf-disclosure") &&
          element.getAttribute("data-inf-disclosure") === source.getAttribute("data-inf-disclosure")) continue;
      if (!source.hasAttribute(name)) element.removeAttribute(name);
    }
    for (i = 0; i < source.attributes.length; i++) {
      var attribute = source.attributes[i];
      if (element.getAttribute(attribute.name) !== attribute.value) element.setAttribute(attribute.name, attribute.value);
    }
  }
  function bridgeError(code, message) {
    var error = new Error(message);
    error.name = "FrameBridgeError";
    error.code = code;
    return error;
  }
  function request(verb, payload) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      var message = { type: "request", id: id, verb: verb };
      for (var key in payload) message[key] = payload[key];
      post(message);
    });
  }
  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.fm !== VERSION || typeof data.type !== "string") return;
    if (data.type === "initialize") {
      if (data.document !== documentId) return;
      var born = document.readyState === "loading"
        ? new Promise(function (resolve) { document.addEventListener("DOMContentLoaded", resolve, { once: true }); })
        : Promise.resolve();
      // A host whose pictures can arrive long after the body (a phone's
      // come over its connection) has the drawing wait only for the fonts
      // its layout asked for: WebKit resolves document.fonts.ready only
      // after the page's load event, which waits for every picture
      // (INF-1562).
      var latePictures = data.latePictures === true;
      born.then(function () {
        capFigures();
        if (document.body) document.body.getBoundingClientRect();
        return latePictures ? fontsIn() : document.fonts.ready;
      }).then(function () {
        requestAnimationFrame(function () { requestAnimationFrame(function () {
          initialized = true;
          resize();
        }); });
      });
    } else if (data.type === "response") {
      if (data.document !== documentId) return;
      var waiter = pending[data.id];
      if (!waiter) return;
      delete pending[data.id];
      if (data.ok) waiter.resolve(data.result);
      else waiter.reject(bridgeError(data.error.code, data.error.message));
    } else if (data.type === "data") {
      var subscription = subscriptions[data.sub];
      if (!subscription) return;
      if (data.error) {
        if (subscription.onError) subscription.onError(bridgeError(data.error.code, data.error.message));
      } else {
        subscription.value = receiveReadValue(subscription.value, data);
        subscription.onValue(subscription.value);
      }
    } else if (data.type === "ping") {
      post({ type: "pong", seq: data.seq });
    } else if (data.type === "state") {
      if (!stateSeen) {
        stateSeen = true;
        birthState = data.state;
      }
      state = data.state;
      stateListeners.slice().forEach(function (listener) { listener(state); });
    } else if (data.type === "store") {
      storeListeners.slice().forEach(function (listener) { listener(data.key); });
    } else if (data.type === "form") {
      form.fill = Array.isArray(data.fill) ? data.fill : null;
      form.locked = data.readOnly === true;
      if (hold) hold.form = true;
      else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startForm);
      else startForm();
    } else if (data.type === "tasks") {
      var known = {};
      var any = false;
      (Array.isArray(data.keys) ? data.keys : []).forEach(function (key) {
        if (typeof key === "string") { known[key] = true; any = true; }
      });
      keys.known = any ? known : null;
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", linkKeys, { once: true });
      else linkKeys();
    } else if (data.type === "lit") {
      keys.lit = typeof data.key === "string" ? data.key : null;
      markLit();
    } else if (data.type === "entries") {
      var named = {};
      var some = false;
      (Array.isArray(data.entries) ? data.entries : []).forEach(function (entry) {
        if (entry && typeof entry.id === "string" && typeof entry.label === "string") {
          named[entry.id] = { label: entry.label, tone: entry.tone === "ok" || entry.tone === "warn" ? entry.tone : "none" };
          some = true;
        }
      });
      entries.known = some ? named : null;
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", linkKeys, { once: true });
      else {
        refreshEntries();
        linkKeys();
      }
    } else if (data.type === "keys") {
      caps.pictures = data.pictures === true;
      caps.escape = data.escape === true;
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tagPictures, { once: true });
      else tagPictures();
    } else if (data.type === "focus") {
      returnFocus();
    } else if (data.type === "move") {
      pressMove(data.key);
    } else if (data.type === "annotation") {
      if (data.document !== documentId) return;
      annotation.enabled = true; annotation.mode = data.mode === true;
      annotation.queued = data.queued || []; annotation.current = data.current || null;
      paintAnnotations();
      if (data.focus) { window.getSelection()?.removeAllRanges(); document.body.tabIndex = -1; document.body.focus(); }
      else if (data.clear) window.getSelection()?.removeAllRanges();
    } else if (data.type === "annotate-selection") {
      // The phone's own Annotate in the selection's menu: the words selected now open the popover with its comment ready.
      if (data.document === documentId) selectedAnnotation(true);
    } else if (data.type === "reveal") {
      if (data.document !== documentId || !Number.isSafeInteger(data.seq) || !Number.isSafeInteger(data.start)) return;
      var stamp = document.querySelector("[data-inf-revision-offer]");
      if (!stamp || stamp.getAttribute("data-inf-revision-offer") !== data.offerId) return;
      var targets = document.querySelectorAll('[data-inf-target="' + data.start + '"]');
      var target = targets.length === 1 ? targets[0] : null;
      if (!target) { post({ type: "revealed", seq: data.seq, offerId: data.offerId }); return; }
      var ancestor = target.parentElement;
      while (ancestor) { if (ancestor.tagName === "DETAILS") ancestor.open = true; ancestor = ancestor.parentElement; }
      resize();
      requestAnimationFrame(function () {
        if (!target.isConnected) { post({type: "revealed", seq: data.seq, offerId: data.offerId}); return; }
        var range = data.span ? annotationRange(target, data.span) : null;
        if (data.span && !range) { post({type: "revealed", seq: data.seq, offerId: data.offerId}); return; }
        var rect = (range || target).getBoundingClientRect();
        if (!target.getClientRects().length) { post({type: "revealed", seq: data.seq, offerId: data.offerId}); return; }
        document.querySelectorAll("[data-inf-revision-highlight]").forEach(function (el) { el.removeAttribute("data-inf-revision-highlight"); });
        if (range && globalThis.CSS && CSS.highlights) {
          CSS.highlights.set("inf-point-reveal", new Highlight(range));
          setTimeout(function () { CSS.highlights.delete("inf-point-reveal"); }, 1000);
        } else {
          target.setAttribute("data-inf-revision-highlight", "");
          setTimeout(function () { target.removeAttribute("data-inf-revision-highlight"); }, 1000);
        }
        if (data.keyboard) { if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1"); target.focus({preventScroll: true}); }
        post({ type: "revealed", seq: data.seq, offerId: data.offerId, top: rect.top + window.scrollY, height: rect.height });
      });
    } else if (data.type === "collect") {
      readForm(data.seq);
      if (data.focusUnpicked) focusUnpicked();
    } else if (data.type === "width") {
      sized = true;
      document.documentElement.setAttribute("data-width", String(data.width));
      capFigures();
    } else if (data.type === "inset") {
      // The box the card's chrome holds over this document's top right: the
      // stylesheet's [data-inf-inset] spacer keeps the first lines clear of it.
      var box = document.documentElement.style;
      box.setProperty("--inf-inset-width", Math.max(0, Number(data.width) || 0) + "px");
      box.setProperty("--inf-inset-height", Math.max(0, Number(data.height) || 0) + "px");
    } else if (data.type === "activate") {
      activate();
    } else if (data.type === "markup") {
      if (typeof data.html === "string") refreshMarkup(data.html);
    } else if (data.type === "theme") {
      theme = data.theme;
      document.documentElement.setAttribute("data-theme", theme);
      if (document.body) document.body.setAttribute("data-theme", theme);
      themeListeners.slice().forEach(function (listener) { listener(theme); });
    }
  });
  var fm = {
    version: VERSION,
    get theme() { return theme; },
    get state() { return state; },
    get birthState() { return birthState; },
    onTheme: function (listener) {
      themeListeners.push(listener);
      return function () {
        themeListeners = themeListeners.filter(function (l) { return l !== listener; });
      };
    },
    onState: function (listener) {
      stateListeners.push(listener);
      return function () {
        stateListeners = stateListeners.filter(function (l) { return l !== listener; });
      };
    },
    subscribe: function (read, args, onValue, onError) {
      var sub = nextId++;
      subscriptions[sub] = { onValue: onValue, onError: onError };
      var ready = request("subscribe", { sub: sub, read: read, args: args === undefined ? {} : args });
      ready.catch(function () { delete subscriptions[sub]; });
      return {
        ready: ready,
        unsubscribe: function () {
          if (!subscriptions[sub]) return Promise.resolve();
          delete subscriptions[sub];
          return request("unsubscribe", { sub: sub });
        }
      };
    },
    action: function (id, value) {
      return request("action", value === undefined ? { action: String(id) } : { action: String(id), value: value });
    },
    fetch: function (alias, req) {
      return request("fetch", { alias: String(alias), request: req });
    },
    store: function (req) {
      return request("store", req);
    },
    // A data file the card's own body names by \`src\` (docs/card-authoring.md,
    // "Data by reference"): the host answers its text, never another file.
    data: function (src) {
      return request("data", { src: String(src) });
    },
    onStore: function (listener) {
      storeListeners.push(listener);
      return function () {
        storeListeners = storeListeners.filter(function (l) { return l !== listener; });
      };
    },
    // One of the body's own drawings in the picture viewer, as it stands, when
    // its script asks: a playable preview's drawings are its controls, which a
    // press opens nothing from (INF-3107), so its own Full screen asks here.
    picture: function (drawing) {
      if (!caps.pictures || !drawing || drawing.localName !== "svg") return;
      post({ type: "image", index: 0, pictures: [drawingPicture(drawing)], asked: true });
    },
    stage: function (name, value) {
      var json = value === undefined ? undefined : JSON.stringify(value);
      if (json === undefined) delete form.staged[String(name)];
      else form.staged[String(name)] = json;
      if (form.on) readForm();
    }
  };
  Object.freeze(fm);
  // The same bridge under every spelling's name: window.inf, and window.fm
  // for a body written before the Infinitary rename.
  ${SPELLINGS.map((spelling) => `window.${spelling} = fm;`).join(" ")}
  ${SPELLINGS.map(
    (spelling) =>
      `window.${spelling}Action = function (id) { fm.action(id).catch(function () {}); };`,
  ).join(" ")}
  var STRIP_SHOWN = ${PICTURE_STRIP_SHOWN};
  function groupPictures(group) {
    var pictures = [];
    for (var i = 0; i < group.children.length; i++) {
      if (group.children[i].tagName === "IMG") pictures.push(group.children[i]);
    }
    return pictures;
  }
  function showPictures(pictures, index) {
    post({
      type: "image",
      index: index,
      pictures: pictures.map(function (picture) {
        return {
          src: picture.currentSrc || picture.src,
          alt: picture.getAttribute("alt") || "",
          width: picture.naturalWidth || 0,
          height: picture.naturalHeight || 0
        };
      })
    });
  }
  function openPicture(picture) {
    var demo = demoOf(picture.closest("figure[data-inf-demo]"));
    if (demo && demo.poster === picture) {
      showDemo(demo, false);
      return;
    }
    var group = picture.closest(".inf-pictures");
    var members = group ? groupPictures(group) : [];
    var index = members.indexOf(picture);
    if (index < 0) {
      members = [picture];
      index = 0;
    }
    showPictures(members, index);
  }
  var DEMO_SOURCE = ${JSON.stringify(FRAME_DEMO_SOURCE)};
  var DEMO_CAPTION_MAX = ${FRAME_DEMO_CAPTION_MAX};
  function demoOf(figure) {
    if (!figure || !figure.hasAttribute("data-inf-demo")) return null;
    var src = figure.getAttribute("data-inf-demo") || "";
    var poster = figure.querySelector("img");
    if (src.indexOf(DEMO_SOURCE) !== 0 || !poster) return null;
    return { figure: figure, src: src, poster: poster };
  }
  function demoMs(figure) {
    var ms = Math.round(Number(figure.getAttribute("data-inf-demo-duration")));
    return ms > 0 && ms < 600000 ? ms : 0;
  }
  function showDemo(demo, play) {
    var caption = demo.figure.querySelector("figcaption");
    var poster = demo.poster;
    post({
      type: "demo",
      src: demo.src,
      play: play,
      durationMs: demoMs(demo.figure),
      caption: caption ? (caption.textContent || "").replace(/\\s+/g, " ").trim().slice(0, DEMO_CAPTION_MAX) : "",
      poster: {
        src: poster.currentSrc || poster.src,
        alt: poster.getAttribute("alt") || "",
        width: poster.naturalWidth || 0,
        height: poster.naturalHeight || 0
      }
    });
  }
  // Each verified demo gets its Play button, with the recording's length,
  // under its poster: drawn with the body, so it is part of its first drawing.
  // A figure is done only once it has its button: the parser can pause after
  // the figure's start tag, before its poster, and the next change draws it.
  function decorateDemos() {
    if (!document.body) return false;
    var figures = document.querySelectorAll("figure[data-inf-demo]:not([data-inf-demo-ready])");
    var drawn = false;
    for (var i = 0; i < figures.length; i++) {
      var demo = demoOf(figures[i]);
      if (!demo) continue;
      figures[i].setAttribute("data-inf-demo-ready", "");
      var seconds = Math.max(1, Math.round(demoMs(demo.figure) / 1000));
      var button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-inf-demo-play", "");
      button.setAttribute("aria-label", "Play the demo, " + seconds + (seconds === 1 ? " second" : " seconds"));
      button.textContent = "Play \u00b7 " + seconds + " s";
      demo.poster.insertAdjacentElement("afterend", button);
      drawn = true;
    }
    return drawn;
  }
  var PICTURE_CONTROL = "a, button, summary, label, [data-inf-action]";
  var UNSHOWN_PICTURE = ".inf-pictures > img:nth-of-type(n+7)";
  // A diagram (INF-3107): an inline drawing a press opens in the picture
  // viewer, as a picture does - the outermost drawing in a figure, or one
  // drawn the width of what holds it. A small mark beside words, a drawing
  // inside a control and one in a caption are not diagrams.
  var DRAWING_CONTROL = PICTURE_CONTROL + ", input, select, textarea, figcaption";
  function outermostDrawing(element) {
    var drawing = element && element.closest ? element.closest("svg") : null;
    while (drawing && drawing.parentElement && drawing.parentElement.closest("svg")) {
      drawing = drawing.parentElement.closest("svg");
    }
    return drawing;
  }
  function isDiagram(drawing) {
    if (!drawing || drawing.closest(DRAWING_CONTROL)) return false;
    var figure = drawing.closest("figure");
    if (figure && !figure.hasAttribute("data-inf-demo")) return true;
    var holder = drawing.parentElement;
    if (!holder) return false;
    var space = getComputedStyle(holder);
    if (/^(inline|contents|none)/.test(space.display)) return false;
    var room = holder.clientWidth - (parseFloat(space.paddingLeft) || 0) - (parseFloat(space.paddingRight) || 0);
    return room > 0 && drawing.getBoundingClientRect().width >= room - 1;
  }
  // The diagram as it stands, whole on its own: every element keeps the
  // look the card gave it - the theme's colors, the author's classes, the
  // stylesheet's type - written on the element, with the card's own faces
  // for the families it uses, at its own size, one unit to a pixel. No
  // script and no handler goes with it; the host shows it as a picture,
  // which runs nothing and loads nothing.
  var SVG_SPACE = "http://www.w3.org/2000/svg";
  var DRAWING_LOOK = ${JSON.stringify(DRAWING_LOOK)};
  var DRAWING_WORDS_LOOK = ${JSON.stringify(DRAWING_WORDS_LOOK)};
  function lookOf(element, names, families) {
    var computed = getComputedStyle(element);
    var look = "";
    for (var i = 0; i < names.length; i++) {
      var value = computed.getPropertyValue(names[i]);
      if (value) look += names[i] + ":" + value + ";";
    }
    computed.fontFamily.split(",").forEach(function (family) {
      families[family.trim().replace(/^["']|["']$/g, "").toLowerCase()] = true;
    });
    return look;
  }
  function facesFor(families) {
    var faces = "";
    for (var i = 0; i < document.styleSheets.length; i++) {
      var rules;
      try { rules = document.styleSheets[i].cssRules; } catch (error) { continue; }
      for (var j = 0; j < rules.length; j++) {
        var rule = rules[j];
        if (rule.type !== 5) continue;
        var family = rule.style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, "").toLowerCase();
        if (families[family]) faces += rule.cssText + "\\n";
      }
    }
    return faces;
  }
  function drawingPicture(drawing) {
    var copy = drawing.cloneNode(true);
    var from = [drawing].concat(Array.prototype.slice.call(drawing.querySelectorAll("*")));
    var to = [copy].concat(Array.prototype.slice.call(copy.querySelectorAll("*")));
    var families = {};
    var scripts = [];
    for (var i = 0; i < from.length; i++) {
      var element = to[i];
      if (element.localName === "script") { scripts.push(element); continue; }
      for (var a = element.attributes.length - 1; a >= 0; a--) {
        if (/^on/i.test(element.attributes[a].name)) element.removeAttribute(element.attributes[a].name);
      }
      element.removeAttribute("tabindex");
      element.removeAttribute("data-inf-picture");
      element.setAttribute("style", lookOf(from[i], from[i].namespaceURI === SVG_SPACE ? DRAWING_LOOK : DRAWING_WORDS_LOOK, families));
    }
    scripts.forEach(function (script) { script.remove(); });
    var box = drawing.viewBox && drawing.viewBox.baseVal;
    var drawn = drawing.getBoundingClientRect();
    var width = box && box.width > 0 ? box.width : drawn.width;
    var height = box && box.height > 0 ? box.height : drawn.height;
    if (!(box && box.width > 0 && box.height > 0)) copy.setAttribute("viewBox", "0 0 " + width + " " + height);
    copy.setAttribute("width", String(width));
    copy.setAttribute("height", String(height));
    var faces = facesFor(families);
    if (faces) {
      var sheet = document.createElementNS(SVG_SPACE, "style");
      sheet.textContent = faces;
      copy.insertBefore(sheet, copy.firstChild);
    }
    var figure = drawing.closest("figure");
    var caption = figure ? figure.querySelector("figcaption") : null;
    var words = caption ? caption.textContent : (figure && figure.getAttribute("aria-label")) || drawing.getAttribute("aria-label") || "";
    return {
      src: ${JSON.stringify(DRAWING_SOURCE_PREFIX)} + encodeURIComponent(new XMLSerializer().serializeToString(copy)),
      alt: (words || "").replace(/\\s+/g, " ").trim().slice(0, ${FRAME_PICTURE_ALT_MAX}),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height))
    };
  }
  function openDrawing(drawing) {
    post({ type: "image", index: 0, pictures: [drawingPicture(drawing)] });
  }
  function tagPictures() {
    if (!caps.pictures || !document.body) return;
    var pictures = document.querySelectorAll("img:not([data-inf-picture]):not([tabindex])");
    var tagged = false;
    for (var i = 0; i < pictures.length; i++) {
      var picture = pictures[i];
      if (picture.closest(PICTURE_CONTROL) || picture.matches(UNSHOWN_PICTURE)) continue;
      picture.setAttribute("data-inf-picture", "");
      picture.setAttribute("tabindex", "0");
      tagged = true;
    }
    var drawings = document.querySelectorAll("svg:not([data-inf-picture]):not([tabindex])");
    for (var d = 0; d < drawings.length; d++) {
      var drawing = drawings[d];
      if (outermostDrawing(drawing) !== drawing || !isDiagram(drawing)) continue;
      drawing.setAttribute("data-inf-picture", "");
      drawing.setAttribute("tabindex", "0");
      tagged = true;
    }
    if (!tagged) return;
    // The same pictures in the same place: a stop for the keyboard is not the body changing.
    sizeWatch.takeRecords();
  }
  function moreTileIndex(group, x, y) {
    var pictures = groupPictures(group);
    if (pictures.length <= STRIP_SHOWN) return -1;
    var tile = getComputedStyle(group, "::after");
    if (tile.content === "none" || tile.display === "none") return -1;
    var last = pictures[STRIP_SHOWN - 1];
    var lastBox = last.getBoundingClientRect();
    var box = group.getBoundingClientRect();
    var width = parseFloat(tile.width) || 0;
    var height = parseFloat(tile.height) || 0;
    var left = lastBox.right + (parseFloat(getComputedStyle(group).columnGap) || 0);
    var top = lastBox.top;
    if (left + width > box.right + 0.5) {
      left = box.left;
      top = lastBox.bottom + (parseFloat(getComputedStyle(last).marginBottom) || 0);
    }
    return x >= left && x <= left + width && y >= top && y <= top + height ? STRIP_SHOWN : -1;
  }
  document.addEventListener("click", function (event) {
    var target = event.target;
    var action = target && target.closest ? target.closest("[data-inf-action]") : null;
    if (action) {
      event.preventDefault();
      window.infAction(action.getAttribute("data-inf-action"));
      return;
    }
    var draft = target && target.closest ? target.closest("[data-inf-draft]") : null;
    if (draft) {
      event.preventDefault();
      post({ type: "draft", text: draft.getAttribute("data-inf-draft") });
      return;
    }
    var task = keyLink(target);
    if (task) {
      event.preventDefault();
      openKey(task);
      return;
    }
    var reference = entryLink(target);
    if (reference) {
      event.preventDefault();
      openEntry(reference);
      return;
    }
    var link = target && target.closest ? target.closest("a[href]") : null;
    if (link) {
      event.preventDefault();
      post({ type: "link", href: link.getAttribute("href") });
      return;
    }
    if (event.defaultPrevented || !target || !target.closest) return;
    var play = target.closest("[data-inf-demo-play]");
    if (play) {
      var playing = demoOf(play.closest("figure[data-inf-demo]"));
      if (playing) showDemo(playing, true);
      return;
    }
    var picture = target.closest("img");
    if (picture) {
      if (picture.closest("button, summary, label")) return;
      openPicture(picture);
      return;
    }
    if (caps.pictures && !target.closest(DRAWING_CONTROL)) {
      var drawing = outermostDrawing(target);
      if (drawing && isDiagram(drawing)) {
        openDrawing(drawing);
        return;
      }
    }
    if (target.classList.contains("inf-pictures")) {
      var more = moreTileIndex(target, event.clientX, event.clientY);
      if (more >= 0) showPictures(groupPictures(target), more);
    }
  });
  function kindOf(control) {
    if (control.tagName === "SELECT") return "select";
    if (control.tagName === "TEXTAREA") return "text";
    var type = (control.getAttribute("type") || "text").toLowerCase();
    if (type === "radio" || type === "checkbox" || type === "hidden") return type;
    if (type === "submit" || type === "button" || type === "reset" || type === "image" || type === "file") return "";
    return "text";
  }
  function words(node) {
    return (node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500);
  }
  function labelOf(control) {
    var parts = [];
    for (var i = 0; control.labels && i < control.labels.length; i++) parts.push(words(control.labels[i]));
    return parts.join(" ").trim();
  }
  function questions() {
    var list = [];
    var byName = {};
    var controls = document.querySelectorAll("input[name], select[name], textarea[name]");
    for (var i = 0; i < controls.length; i++) {
      var control = controls[i];
      var kind = kindOf(control);
      if (!kind || control.disabled || !control.name) continue;
      if (kind === "hidden" && !form.first.has(control)) form.first.set(control, control.value);
      var group = byName[control.name];
      if (!group) {
        group = byName[control.name] = { name: control.name, controls: [], required: false };
        list.push(group);
      }
      group.controls.push(control);
      if (control.required) group.required = true;
    }
    for (var name in form.staged) {
      if (!byName[name]) {
        byName[name] = { name: name, controls: [], required: false };
        list.push(byName[name]);
      }
      byName[name].staged = true;
    }
    return list;
  }
  function recommended(control, fallback) {
    var owner = control.tagName === "OPTION" ? control.closest("select") : control;
    var marked = owner.tagName === "SELECT"
      ? owner.querySelector("option[data-inf-recommended]")
      : document.querySelector('input[name="' + CSS.escape(control.name) + '"][data-inf-recommended]');
    return marked ? control.hasAttribute("data-inf-recommended") : fallback;
  }
  // A question's Something else row (FI3-1002): the author writes it as one
  // more radio or checkbox of the question, or an <option> of its select,
  // marked data-inf-write-in. It is never an option value: once picked the
  // app opens a text field under it, and the words in it are the answer.
  function isWriteIn(control) {
    return control.hasAttribute("data-inf-write-in");
  }
  function rowPicked(row) {
    return row.tagName === "OPTION" ? row.selected : row.checked;
  }
  function writeInRows(group) {
    var rows = [];
    group.controls.forEach(function (control) {
      var kind = kindOf(control);
      if ((kind === "radio" || kind === "checkbox") && isWriteIn(control)) rows.push(control);
      else if (kind === "select") {
        for (var i = 0; i < control.options.length; i++) if (isWriteIn(control.options[i])) rows.push(control.options[i]);
      }
    });
    return rows;
  }
  function pickedWriteIn(group) {
    return writeInRows(group).find(rowPicked) || null;
  }
  function writtenOf(row) {
    var field = row && form.fields.get(row);
    return field && rowPicked(row) ? field.value.trim().slice(0, WRITTEN_MAX) : "";
  }
  function hasAnswer(answer) {
    return answer.values.length > 0 || answer.written !== undefined;
  }
  function focusUnpicked() {
    var group = questions().find(function (group) { return group.required && !hasAnswer(answerOf(group)); });
    if (!group) return;
    // A picked Something else with nothing written: its field is what waits.
    var field = form.fields.get(pickedWriteIn(group));
    var control = field && !field.hidden ? field : group.controls.find(function (control) { return !control.disabled && !boxless(control); });
    if (control) { control.focus(); control.scrollIntoView({ block: "center", behavior: "smooth" }); }
  }
  // A question that recommends rather than pre-picks: nothing is chosen
  // until the captain chooses, so any answer it has is the captain's pick.
  function tagged(group) {
    return group.controls.some(function (control) { return control.hasAttribute("data-inf-recommended") || (kindOf(control) === "select" && control.querySelector("option[data-inf-recommended]")); });
  }
  function answerOf(group) {
    if (group.staged) return { name: group.name, values: [form.staged[group.name]], changed: true, json: true };
    var values = [];
    var labels = [];
    var proposed = [];
    function pick(value, label) {
      if (value === "") return;
      values.push(value);
      labels.push(label);
    }
    group.controls.forEach(function (control) {
      var kind = kindOf(control);
      if (kind === "radio" || kind === "checkbox") {
        if (isWriteIn(control)) return;
        if (control.checked) pick(control.value, labelOf(control));
        if (recommended(control, control.defaultChecked) && control.value !== "") proposed.push(control.value);
      } else if (kind === "select") {
        var marked = false;
        for (var i = 0; i < control.options.length; i++) {
          var option = control.options[i];
          if (isWriteIn(option)) continue;
          if (option.selected) pick(option.value, words(option));
          if (recommended(option, option.defaultSelected)) {
            marked = true;
            if (option.value !== "") proposed.push(option.value);
          }
        }
        var first = control.options[0];
        if (!marked && !control.multiple && first && first.value !== "" && !isWriteIn(first)) proposed.push(first.value);
      } else {
        pick(control.value, "");
        var initial = kind === "hidden" ? form.first.get(control) : control.defaultValue;
        if (initial) proposed.push(initial);
      }
    });
    // The captain's own words are never what the author proposed.
    var written = writtenOf(pickedWriteIn(group));
    var changed = written !== "" || ((!tagged(group) || values.length > 0) && JSON.stringify(values.slice().sort()) !== JSON.stringify(proposed.sort()));
    var answer = { name: group.name, values: values, changed: changed };
    if (labels.some(function (label) { return label !== ""; })) answer.labels = labels;
    if (written) answer.written = written;
    return answer;
  }
  function wording(text) {
    var whole = (text || "").replace(/\\s+/g, " ").trim();
    return { text: whole.slice(0, LABEL_MAX), cut: whole.length > LABEL_MAX };
  }
  // A node's own words: the text of a control it wraps - a select's
  // options, a textarea's default - is an answer, never the question.
  function spoken(node) {
    var copy = node.cloneNode(true);
    var inner = copy.querySelectorAll("select, textarea, script, style");
    for (var i = 0; i < inner.length; i++) inner[i].remove();
    return copy.textContent || "";
  }
  function byIds(ids) {
    var parts = [];
    (ids || "").split(/\\s+/).forEach(function (id) {
      var node = id ? document.getElementById(id) : null;
      if (node) parts.push(spoken(node));
    });
    return parts.join(" ");
  }
  function ownWording(node) {
    if (node.hasAttribute("aria-labelledby")) return { raw: byIds(node.getAttribute("aria-labelledby")), basis: "labelledby" };
    if (node.hasAttribute("aria-label")) return { raw: node.getAttribute("aria-label"), basis: "aria-label" };
    if (node.tagName === "FIELDSET") {
      for (var i = 0; i < node.children.length; i++) {
        if (node.children[i].tagName === "LEGEND") return { raw: spoken(node.children[i]), basis: "legend" };
      }
    }
    return null;
  }
  function holderOf(control) {
    for (var node = control.parentElement; node && node !== document.body; node = node.parentElement) {
      var role = node.getAttribute("role");
      if (node.tagName === "FIELDSET" || role === "group" || role === "radiogroup") return node;
    }
    return null;
  }
  function promptOf(controls, lone) {
    if (lone) {
      var own = ownWording(controls[0]);
      if (own && own.raw) return own;
      var bound = [];
      for (var i = 0; controls[0].labels && i < controls[0].labels.length; i++) bound.push(spoken(controls[0].labels[i]));
      if (bound.join("").trim()) return { raw: bound.join(" "), basis: "label" };
    }
    var holders = controls.map(holderOf);
    var holder = holders[0];
    if (holders.every(function (each) { return each === holder; })) {
      if (holder) return ownWording(holder) || { gap: "no-prompt" };
    } else if (holders.some(function (each) { return each; })) return { gap: "conflicting-prompt" };
    var first = controls.map(function (control) { return (control.getAttribute("aria-labelledby") || "").split(/\\s+/)[0]; });
    if (!lone && first[0] && first.every(function (id) { return id === first[0]; })) return { raw: byIds(first[0]), basis: "labelledby" };
    return { gap: "no-prompt" };
  }
  function boxless(node) {
    return node.hidden || node.getClientRects().length === 0;
  }
  function defineQuestion(group) {
    var gaps = [];
    function gap(name) { if (gaps.indexOf(name) < 0) gaps.push(name); }
    function label(text) {
      var read = wording(text);
      if (read.cut) gap("label-truncated");
      return read.text || null;
    }
    var definition = { name: group.name, kind: "opaque", control: "staged", prompt: null, promptBasis: null, options: [], defaultBasis: "none", required: group.required, gaps: gaps, complete: false };
    if (group.staged) {
      gap("opaque");
      return definition;
    }
    var all = [];
    var named = document.getElementsByName(group.name);
    for (var i = 0; i < named.length; i++) if (kindOf(named[i])) all.push(named[i]);
    var kinds = [];
    group.controls.forEach(function (control) {
      var kind = kindOf(control);
      if (kinds.indexOf(kind) < 0) kinds.push(kind);
    });
    var kind = kinds.length === 1 ? kinds[0] : "mixed";
    var first = group.controls[0];
    if (kind === "mixed") {
      gap("mixed-controls");
      definition.control = "mixed";
    } else if (kind === "hidden") {
      definition.control = "hidden";
      if (form.first.get(first)) definition.defaultBasis = "authored";
    } else if (kind === "radio" || kind === "checkbox") {
      definition.control = kind;
      definition.kind = kind === "radio" ? "single" : "multiple";
      all.forEach(function (control) {
        if (kindOf(control) !== kind) return;
        if (isWriteIn(control)) {
          definition.writeIn = true;
          return;
        }
        definition.options.push({ value: control.value, label: label(labelOf(control)), authoredDefault: recommended(control, control.defaultChecked), disabled: control.disabled, hidden: boxless(control) });
      });
      if (definition.options.some(function (option) { return option.authoredDefault; })) definition.defaultBasis = "authored";
    } else if (kind === "select") {
      definition.control = first.multiple ? "select-multiple" : "select";
      definition.kind = first.multiple ? "multiple" : "single";
      group.controls.forEach(function (control) {
        for (var i = 0; i < control.options.length; i++) {
          var option = control.options[i];
          if (isWriteIn(option)) {
            definition.writeIn = true;
            continue;
          }
          definition.options.push({ value: option.value, label: label(option.textContent), authoredDefault: recommended(option, option.defaultSelected), disabled: option.disabled, hidden: option.hidden });
        }
      });
      if (definition.options.some(function (option) { return option.authoredDefault; })) definition.defaultBasis = "authored";
      else if (!first.multiple && first.options[0] && first.options[0].value !== "") definition.defaultBasis = "implicit-first";
    } else {
      definition.control = first.tagName === "TEXTAREA" ? "textarea" : "text";
      definition.kind = "text";
      if (group.controls.some(function (control) { return control.defaultValue; })) definition.defaultBasis = "authored";
    }
    if (definition.kind === "opaque") {
      gap("opaque");
      return definition;
    }
    var values = definition.options.map(function (option) { return option.value; });
    if (values.some(function (value, index) { return values.indexOf(value) !== index; })) gap("duplicate-values");
    var lone = group.controls.length === 1 && (kind === "text" || kind === "select");
    var prompt = promptOf(group.controls, lone);
    if (prompt.gap || !wording(prompt.raw).text) gap(prompt.gap || "no-prompt");
    else {
      definition.prompt = label(prompt.raw);
      definition.promptBasis = prompt.basis;
    }
    definition.complete = gaps.length === 0;
    return definition;
  }
  function readForm(seq) {
    var answers = [];
    var answered = 0;
    var changed = 0;
    var picked = 0;
    var groups = questions();
    groups.forEach(function (group) {
      var answer = answerOf(group);
      answers.push(answer);
      if (!group.required || hasAnswer(answer)) answered += 1;
      if (answer.changed) changed += 1;
      // The captain's own answers, which a close would lose: a change from
      // the author's proposal, a pick where the author only recommended, or
      // words written under Something else. An untouched prefilled field or
      // authored default is not one.
      if (tagged(group) ? hasAnswer(answer) : answer.changed) picked += 1;
    });
    var message = { type: "answers", answered: answered, of: answers.length, changed: changed, picked: picked, answers: answers };
    var key = JSON.stringify(message);
    if (seq === undefined && key === form.last) return;
    form.last = key;
    if (seq !== undefined) {
      message.seq = seq;
      // What the questions offered rides only the reading a footer click
      // asked for, never a draft (docs/card-evidence.md).
      try {
        var defined = groups.map(defineQuestion);
        if (new TextEncoder().encode(JSON.stringify(defined)).byteLength > QUESTIONS_MAX_BYTES) message.questionsGap = "too-large";
        else message.questions = defined;
      } catch (error) {
        message.questionsGap = "invalid";
      }
    }
    post(message);
  }
  function fillForm(answers) {
    var byName = {};
    questions().forEach(function (group) { byName[group.name] = group; });
    var touched = [];
    answers.forEach(function (answer) {
      if (!answer || !Array.isArray(answer.values)) return;
      if (answer.json) {
        if (typeof answer.values[0] === "string") form.staged[answer.name] = answer.values[0];
        return;
      }
      var group = byName[answer.name];
      if (!group || group.staged) return;
      if (!answer.changed && group.controls.every(function (control) { var kind = kindOf(control); return kind === "text" || kind === "hidden"; })) return;
      var values = answer.values.map(String);
      // Words written under Something else come back under the new body's
      // own Something else row; a body with none leaves them at its proposal.
      var written = typeof answer.written === "string" ? answer.written : "";
      var row = written ? writeInRows(group)[0] || null : null;
      if (written && !row && values.length === 0) return;
      var offered = group.controls.some(function (control) {
        var kind = kindOf(control);
        if (kind === "text" || kind === "hidden") return true;
        if (kind !== "select") return values.indexOf(control.value) >= 0;
        for (var i = 0; i < control.options.length; i++) {
          if (values.indexOf(control.options[i].value) >= 0) return true;
        }
        return false;
      });
      if (values.length > 0 && !offered) return;
      var next = 0;
      group.controls.forEach(function (control) {
        var kind = kindOf(control);
        if (kind === "radio" || kind === "checkbox") control.checked = isWriteIn(control) ? control === row : values.indexOf(control.value) >= 0;
        else if (kind === "select") {
          for (var i = 0; i < control.options.length; i++) {
            var option = control.options[i];
            option.selected = isWriteIn(option) ? option === row : values.indexOf(option.value) >= 0;
          }
        } else control.value = values[next++] || "";
        touched.push(control);
      });
      var field = row && writeInField(row);
      if (field) field.value = written;
    });
    form.filling = true;
    try {
      touched.forEach(function (control) {
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
      });
    } finally {
      form.filling = false;
    }
  }
  // The app's own lines under a select, As built first, then Recommended.
  var SELECT_TAGS = ["data-inf-as-built", "data-inf-recommendation"];
  function isSelectTag(element) {
    return element && SELECT_TAGS.some(function (attribute) { return element.hasAttribute(attribute); });
  }
  function tagSelect(select, mark, attribute, word) {
    var options = Array.from(select.options).filter(function (option) { return option.hasAttribute(mark); });
    var tag = null;
    var end = select;
    for (var next = select.nextElementSibling; isSelectTag(next); next = next.nextElementSibling) {
      if (next.hasAttribute(attribute)) tag = next;
      end = next;
    }
    if (!tag) {
      if (!options.length) return;
      tag = document.createElement("span");
      tag.setAttribute(attribute, "");
      (attribute === SELECT_TAGS[0] ? select : end).after(tag);
    }
    var text = options.length ? word + ": " + options.map(words).join(", ") : "";
    if (tag.textContent !== text) tag.textContent = text;
  }
  // Recommended is the author's pick; As built (data-inf-current) is what the
  // code does now. Both only tag: neither picks an option nor joins the answer.
  function tagRecommendations() {
    [["data-inf-current", "data-inf-current-label"], ["data-inf-recommended", "data-inf-recommended-label"]].forEach(function (pair) {
      document.querySelectorAll("input[" + pair[0] + "]:is([type=radio], [type=checkbox])").forEach(function (control) {
        Array.from(control.labels || []).forEach(function (label) { if (!label.hasAttribute(pair[1])) label.setAttribute(pair[1], ""); });
      });
    });
    document.querySelectorAll("select").forEach(function (select) {
      tagSelect(select, "data-inf-current", "data-inf-as-built", ${JSON.stringify(AS_BUILT_WORDS)});
      tagSelect(select, "data-inf-recommended", "data-inf-recommendation", "Recommended");
    });
  }
  // The field under a Something else row: the app's own, with no name, so
  // its words ride the row's question as "written" and never a question of
  // their own. One line that grows to three (the frame stylesheet).
  function writeInField(row) {
    var field = form.fields.get(row);
    if (field && field.isConnected) return field;
    var owner = row.tagName === "OPTION" ? row.closest("select") : row;
    if (!owner || !owner.name) return null;
    field = document.createElement("textarea");
    field.setAttribute("data-inf-write-in-field", owner === row ? "row" : "select");
    field.rows = 1;
    field.maxLength = WRITTEN_MAX;
    field.placeholder = "Say what you want instead";
    var named = [];
    var all = document.getElementsByName(owner.name);
    for (var i = 0; i < all.length; i++) if (kindOf(all[i])) named.push(all[i]);
    var asked = promptOf(named, owner !== row);
    var prompt = asked.gap ? "" : wording(asked.raw).text;
    field.setAttribute("aria-label", prompt ? "Your own answer to: " + prompt : "Your own answer");
    field.hidden = true;
    form.fields.set(row, field);
    var anchor = owner;
    if (owner === row) {
      var label = row.closest("label") || (row.labels && row.labels[row.labels.length - 1]);
      if (label && (label.contains(row) || row.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING)) anchor = label;
    } else {
      while (isSelectTag(anchor.nextElementSibling)) anchor = anchor.nextElementSibling;
    }
    anchor.after(field);
    return field;
  }
  // Each Something else row's field shows only while the row is picked, and
  // keeps its words while it hides: they are sent only with the row.
  function offerWriteIns() {
    document.querySelectorAll('input[data-inf-write-in]:is([type="radio"], [type="checkbox"]), select option[data-inf-write-in]').forEach(function (row) {
      var field = writeInField(row);
      if (!field) return;
      var shown = rowPicked(row);
      if (field.hidden === shown) field.hidden = !shown;
    });
  }
  // Picking Something else puts the captain in its field, ready to write. A
  // pick the bridge restored (a revision's draft) moves no focus.
  function focusWriteIn(event) {
    var target = event.target;
    if (form.filling || form.locked || !target || !target.hasAttribute) return;
    var row = target.tagName === "SELECT"
      ? Array.prototype.find.call(target.selectedOptions, isWriteIn)
      : isWriteIn(target) && target.checked ? target : null;
    var field = row && form.fields.get(row);
    if (field && !field.hidden) field.focus();
  }
  function lockForm() {
    document.querySelectorAll("input, select, textarea, button, fieldset").forEach(function (control) {
      if (!control.disabled) control.disabled = true;
    });
  }
  function dressForm() {
    tagRecommendations();
    offerWriteIns();
  }
  function startForm() {
    dressForm();
    if (form.fill) fillForm(form.fill);
    form.fill = null;
    // A draft filled into a new document shows its rows' fields: no watch
    // heard that fill.
    offerWriteIns();
    if (form.locked) lockForm();
    if (!form.on) {
      form.on = true;
      var watch = function () { dressForm(); if (form.locked) lockForm(); readForm(); };
      document.addEventListener("input", watch, true);
      document.addEventListener("change", watch, true);
      document.addEventListener("change", focusWriteIn);
      new MutationObserver(watch).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["name", "value", "disabled", "required", "checked", "selected", "data-inf-recommended", "data-inf-current", "data-inf-write-in"]
      });
    }
    readForm();
  }
  var lastReported = "";
  var resizeQueued = false;
  var liveChange = false;
  function reading(height, width) {
    return height + ":" + width + ":" + initialized + ":" + (hold !== null);
  }
  function resize() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(function () {
      resizeQueued = false;
      capFigures();
      if (!document.body) return;
      var height = document.body.getBoundingClientRect().height;
      var width = document.documentElement.clientWidth;
      var read = reading(height, width);
      if (read === lastReported) return;
      lastReported = read;
      var message = { type: "resize", height: height, width: width, initialized: initialized, live: liveChange };
      // A held page's drawing: prepared, its own behavior not started.
      if (hold) message.held = true;
      post(message);
      liveChange = false;
    });
  }
  // A released page reports its drawing at once, without waiting for a
  // frame: a hidden frame's frames are throttled, and the stage shows the
  // card on this report. What its scripts changed is that drawing.
  function reportDrawing() {
    capFigures();
    if (!initialized || !document.body) {
      lastReported = "";
      resize();
      return;
    }
    sizeWatch.takeRecords();
    var height = document.body.getBoundingClientRect().height;
    var width = document.documentElement.clientWidth;
    lastReported = reading(height, width);
    liveChange = false;
    post({ type: "resize", height: height, width: width, initialized: true, live: false });
  }
  var sizeWatch = new MutationObserver(function () {
    if (initialized && !settling) liveChange = true;
    resize();
  });
  sizeWatch.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  function keyLink(target) {
    return target && target.closest ? target.closest("a[data-inf-task]") : null;
  }
  function entryLink(target) {
    return target && target.closest ? target.closest("a[data-inf-entry]") : null;
  }
  function linkText(node) {
    var text = node.nodeValue;
    var parts = null;
    var at = 0;
    var match;
    KEY_IN_TEXT.lastIndex = 0;
    while ((match = KEY_IN_TEXT.exec(text))) {
      var task = keys.known && keys.known[match[0]];
      var entry = !task && entries.known && Object.prototype.hasOwnProperty.call(entries.known, match[0]) ? entries.known[match[0]] : null;
      if (!task && !entry) continue;
      parts = parts || document.createDocumentFragment();
      if (match.index > at) parts.appendChild(document.createTextNode(text.slice(at, match.index)));
      var link = document.createElement("a");
      if (task) {
        link.setAttribute("data-inf-task", match[0]);
      } else {
        link.setAttribute("data-inf-entry", match[0]);
        link.setAttribute("data-inf-standing", entry.tone);
        link.setAttribute("aria-label", entry.label);
        link.setAttribute("title", entry.label);
      }
      link.setAttribute("role", "link");
      link.setAttribute("tabindex", "0");
      link.textContent = match[0];
      parts.appendChild(link);
      at = match.index + match[0].length;
    }
    if (!parts) return false;
    if (at < text.length) parts.appendChild(document.createTextNode(text.slice(at)));
    node.parentNode.replaceChild(parts, node);
    return true;
  }
  // A reference already linked takes its entry's words and mark as they stand now.
  function refreshEntries() {
    if (!entries.known || !document.body) return;
    var changed = false;
    document.querySelectorAll("a[data-inf-entry]").forEach(function (link) {
      var id = link.getAttribute("data-inf-entry");
      var entry = Object.prototype.hasOwnProperty.call(entries.known, id) ? entries.known[id] : null;
      if (!entry) return;
      if (link.getAttribute("data-inf-standing") !== entry.tone) {
        link.setAttribute("data-inf-standing", entry.tone);
        changed = true;
      }
      if (link.getAttribute("aria-label") !== entry.label) {
        link.setAttribute("aria-label", entry.label);
        link.setAttribute("title", entry.label);
        changed = true;
      }
    });
    // The same words in the same place: a mark is not the body changing.
    if (changed) sizeWatch.takeRecords();
  }
  // The key lit by a rest elsewhere in the window (INF-237) takes the hover mark, on every link to it.
  function markLit() {
    document.querySelectorAll("a[data-inf-task]").forEach(function (link) {
      var on = keys.lit !== null && link.getAttribute("data-inf-task") === keys.lit;
      if (on === link.hasAttribute("data-inf-lit")) return;
      if (on) link.setAttribute("data-inf-lit", "");
      else link.removeAttribute("data-inf-lit");
    });
    // A mark is not the body changing.
    sizeWatch.takeRecords();
  }
  function linkKeys() {
    if ((!keys.known && !entries.known) || !document.body) return;
    var found = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue.indexOf("-") < 0 || !node.parentElement) continue;
      if (node.parentElement.closest(UNLINKED)) continue;
      found.push(node);
    }
    var linked = false;
    found.forEach(function (text) { if (linkText(text)) linked = true; });
    if (!linked) return;
    markLit();
    // The same words in the same place: linking is not the body changing.
    sizeWatch.takeRecords();
    keyWatch.takeRecords();
    resize();
  }
  var keyWatch = new MutationObserver(function () {
    if (keys.known || entries.known) linkKeys();
    tagPictures();
    if (decorateDemos()) {
      // A demo the body's own script added: its button is part of that change.
      keyWatch.takeRecords();
    }
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", decorateDemos, { once: true });
  else decorateDemos();
  keyWatch.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  function keyOf(link) {
    return link.getAttribute("data-inf-task");
  }
  function openKey(link) {
    post({ type: "task", gesture: "open", key: keyOf(link) });
  }
  function openEntry(link) {
    post({ type: "entry", id: link.getAttribute("data-inf-entry") });
  }
  function leaveKey() {
    var link = keys.rested;
    if (!link) return;
    keys.rested = null;
    post({ type: "task", gesture: "leave", key: keyOf(link) });
  }
  function restKey(link) {
    keys.rested = link;
    var box = link.getBoundingClientRect();
    post({ type: "task", gesture: "rest", key: keyOf(link), box: { top: box.top, right: box.right, bottom: box.bottom, left: box.left } });
  }
  function quietKey() {
    if (!keys.rested) return false;
    keys.quiet = keys.rested;
    leaveKey();
    return true;
  }
  document.addEventListener("pointerover", function (event) {
    var link = keyLink(event.target);
    // Coming in from outside the frame: the host has let go of whatever
    // rested, and the pointer has left any key it was asked to keep quiet.
    if (!event.relatedTarget) keys.quiet = null;
    if (link !== keys.rested) leaveKey();
    if (!link || link === keys.quiet) return;
    restKey(link);
  });
  document.addEventListener("pointerout", function (event) {
    var link = keyLink(event.target);
    if (!link || (event.relatedTarget && link.contains(event.relatedTarget))) return;
    if (link === keys.quiet) keys.quiet = null;
    if (link === keys.rested) leaveKey();
  });
  document.addEventListener("pointerdown", function (event) {
    if (keyLink(event.target)) quietKey();
  }, true);
  var quieted = null;
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && quietKey()) quieted = event;
    var link = keyLink(event.target);
    if (event.key === "Enter" && link && link === event.target) {
      event.preventDefault();
      openKey(link);
    }
    var reference = entryLink(event.target);
    if (event.key === "Enter" && reference && reference === event.target) {
      event.preventDefault();
      openEntry(reference);
    }
  }, true);
  // The keyboard rests on a key as the pointer does, and leaving it lets go.
  document.addEventListener("focusin", function (event) {
    var target = event.target;
    if (target && target.nodeType === 1 && target !== document.body) {
      held.element = target;
      held.start = null;
    }
    var link = keyLink(target);
    if (link !== keys.rested) leaveKey();
    if (!link || link !== target || link === keys.quiet || !link.matches(":focus-visible")) return;
    // Once the window has brought the key into view, where its summary goes.
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      if (document.activeElement === link && keys.rested !== link) restKey(link);
    }); });
  }, true);
  document.addEventListener("focusout", function (event) {
    var target = event.target;
    // Focus that moved in a page whose process was not yet told it holds the
    // window's focus fired no focusin (Chromium sends it on the page's focus,
    // which a move to another page can pass by): the element focus leaves is
    // the one the page held, unless a press in the body moved it.
    if (target !== held.element && !pressing && target && target.nodeType === 1 && target !== document.body) {
      held.element = target;
    }
    if (target === held.element && typeof target.selectionStart === "number") {
      held.start = target.selectionStart;
      held.end = target.selectionEnd;
      held.direction = target.selectionDirection;
    } else if (target === held.element) {
      held.start = null;
    }
    var link = keyLink(target);
    if (!link) return;
    if (link === keys.quiet) keys.quiet = null;
    if (link === keys.rested) leaveKey();
  }, true);
  // A press elsewhere in the body leaves the field it held for whatever the
  // press focuses, in the same task as the press.
  var pressing = false;
  document.addEventListener("pointerdown", function (event) {
    if (held.element && !held.element.contains(event.target)) held.element = null;
    pressing = true;
    setTimeout(function () { pressing = false; });
  }, true);
  // The host gave the frame focus back (an overlay over the window closed):
  // the field it held takes it again, its caret where it was - unless focus
  // has moved on from the frame since (a command chosen in search moved it).
  function returnFocus() {
    var element = held.element;
    if (!document.hasFocus()) return;
    if (!element || !element.isConnected || element.disabled || boxless(element)) return;
    element.focus({ preventScroll: true });
    if (held.start !== null && typeof element.setSelectionRange === "function") {
      try { element.setSelectionRange(held.start, held.end, held.direction || "none"); } catch (error) {}
    }
  }
  // A movement command's key (docs/keyboard.md, "Moving by a key of your
  // own"): pressed on the focused element for the body's own handlers, and
  // when nothing there used it, done the way the browser does that key: a
  // radio group's next choice, a field's caret, a list's next option, or a
  // scroll. An Escape is the body's own and the bridge's below.
  var MOVES = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1, Home: 0, End: 0, PageUp: 0, PageDown: 0, Escape: 0 };
  function pressMove(key) {
    if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(MOVES, key) || !document.hasFocus()) return;
    var target = document.activeElement || document.body;
    if (!target) return;
    var init = { key: key, code: key, bubbles: true, cancelable: true, composed: true };
    var unused = target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    if (unused && key !== "Escape") moveTheBrowsersWay(target, key);
  }
  function moveTheBrowsersWay(target, key) {
    var step = MOVES[key];
    var name = target.localName;
    if (name === "input" && target.type === "radio" && step !== 0 && target.name) {
      var scope = target.form || document;
      var group = Array.prototype.filter.call(scope.querySelectorAll('input[type="radio"]'), function (radio) {
        return radio.name === target.name && !radio.disabled && !boxless(radio);
      });
      var at = group.indexOf(target);
      var next = group[(at + step + group.length) % group.length];
      if (next && next !== target) { next.focus(); next.click(); }
      return;
    }
    if (name === "select" && !target.multiple && step !== 0) {
      var index = Math.min(Math.max(target.selectedIndex + step, 0), target.options.length - 1);
      if (index !== target.selectedIndex) {
        target.selectedIndex = index;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }
    if ((name === "textarea" || name === "input") && typeof target.selectionStart === "number" && target.selectionStart !== null) {
      var value = target.value;
      var start = target.selectionStart;
      var end = target.selectionEnd;
      var caret;
      if (key === "ArrowLeft") caret = start === end ? Math.max(0, start - 1) : start;
      else if (key === "ArrowRight") caret = start === end ? Math.min(value.length, end + 1) : end;
      else if (name === "textarea" && (key === "ArrowUp" || key === "ArrowDown")) {
        var lineStart = value.lastIndexOf("\\n", start - 1) + 1;
        var column = start - lineStart;
        if (key === "ArrowUp") {
          if (lineStart === 0) caret = 0;
          else {
            var above = value.lastIndexOf("\\n", lineStart - 2) + 1;
            caret = Math.min(above + column, lineStart - 1);
          }
        } else {
          var lineEnd = value.indexOf("\\n", start);
          if (lineEnd === -1) caret = value.length;
          else {
            var belowEnd = value.indexOf("\\n", lineEnd + 1);
            caret = Math.min(lineEnd + 1 + column, belowEnd === -1 ? value.length : belowEnd);
          }
        }
      } else if (key === "ArrowUp" || key === "Home" || key === "PageUp") caret = 0;
      else caret = value.length;
      target.setSelectionRange(caret, caret);
      return;
    }
    var vertical = key !== "ArrowLeft" && key !== "ArrowRight";
    var box = target.nodeType === 1 ? target : null;
    while (box && box !== document.body && box !== document.documentElement) {
      var style = getComputedStyle(box);
      var overflow = vertical ? style.overflowY : style.overflowX;
      var room = vertical ? box.scrollHeight - box.clientHeight : box.scrollWidth - box.clientWidth;
      if (room > 0 && (overflow === "auto" || overflow === "scroll")) break;
      box = box.parentElement;
    }
    if (!box || box === document.body || box === document.documentElement) box = document.scrollingElement || document.documentElement;
    var page = Math.max(40, box.clientHeight * 0.875);
    if (key === "ArrowLeft") box.scrollBy({ left: -40 });
    else if (key === "ArrowRight") box.scrollBy({ left: 40 });
    else if (key === "ArrowUp") box.scrollBy({ top: -40 });
    else if (key === "ArrowDown") box.scrollBy({ top: 40 });
    else if (key === "PageUp") box.scrollBy({ top: -page });
    else if (key === "PageDown") box.scrollBy({ top: page });
    else if (key === "Home") box.scrollTo({ top: 0 });
    else if (key === "End") box.scrollTo({ top: box.scrollHeight });
  }
  // After the body's own handlers: a picture opens on Enter or Space, and
  // an Escape nothing in the body used leaves the body for its card.
  document.addEventListener("keydown", function (event) {
    if (event.defaultPrevented || event.isComposing) return;
    var target = event.target;
    if ((event.key === "Enter" || event.key === " ") && target && target.nodeType === 1 && target.hasAttribute("data-inf-picture")) {
      event.preventDefault();
      if (!event.repeat) {
        if (target.localName === "svg") openDrawing(target);
        else openPicture(target);
      }
      return;
    }
    if (event.key !== "Escape" || !caps.escape || event.repeat || quieted === event) return;
    if (document.querySelector("dialog:modal, :popover-open")) return;
    if (target && target.tagName === "INPUT" && target.type === "search" && target.value !== "") return;
    post({ type: "escape" });
  });
  // Observe at capture, offer after every handler: a body's own used key stays its own.
  window.addEventListener("keydown", function (event) {
    var typing = event.composedPath().some(function (node) {
      return node && node.nodeType === 1 && (node.isContentEditable || node.matches(${JSON.stringify(TYPING_CONTROL_SELECTOR)}));
    });
    setTimeout(function () {
      if (!event.isTrusted || event.defaultPrevented || event.isComposing || event.keyCode === 229 || !document.hasFocus()) return;
      if (typing) return;
      post({ type: "key", press: { key: event.key, code: event.code, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, composing: false, repeat: event.repeat } });
    });
  }, true);
  document.addEventListener("scroll", leaveKey, true);
  new ResizeObserver(resize).observe(document.documentElement);
  window.addEventListener("load", resize);
  ["click", "focusin", "input", "keydown"].forEach(function (type) {
    document.addEventListener(type, function () { post({ type: "interaction" }); }, true);
  });
  // The window's focus moving between two frames passes the page by: each
  // frame says when its own window gains or loses it. Heard before any
  // script of the body's and sent through what the bridge held from its
  // start, so the body cannot keep its frame from saying it.
  var host = window.parent;
  var apply = Reflect.apply;
  var targetOf = Object.getOwnPropertyDescriptor(Event.prototype, "target").get;
  ["focus", "blur"].forEach(function (type) {
    window.addEventListener(type, function (event) {
      if (apply(targetOf, event, []) !== window) return;
      host.postMessage({ fm: VERSION, type: "focused", document: documentId, focused: type === "focus" }, "*");
    }, true);
  });
  // A press beginning in the frame passes the page by too: the frame says
  // so, the same way, before the press's own click or key is sent.
  var repeatOf = Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, "repeat").get;
  window.addEventListener("pointerdown", function () {
    host.postMessage({ fm: VERSION, type: "pressed", document: documentId }, "*");
  }, true);
  window.addEventListener("keydown", function (event) {
    if (apply(repeatOf, event, [])) return;
    host.postMessage({ fm: VERSION, type: "pressed", document: documentId }, "*");
  }, true);
  post({ type: "ready", reuseReads: true });
})();`;

/**
 * SHA-256 of FRAME_BRIDGE_SCRIPT, pinned for every CSP source list. Any edit
 * to the script moves it: re-pin it in the same change, or
 * frameBridgeHash.test.ts fails and every frame's CSP blocks the script.
 */
export const FRAME_BRIDGE_SHA256 = "sha256-cZ1cbkq4+2pYAbd9QoBpJSILsfmjikMInStlh39Reto=";
