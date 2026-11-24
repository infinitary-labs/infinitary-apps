import { CARD_QUESTION_LABEL_MAX, CARD_QUESTIONS_MAX_BYTES, CARD_WRITTEN_MAX } from "../cards";
import { OWN_SPELLING, SPELLINGS } from "../codeNames";
import { TYPING_CONTROL_SELECTOR } from "../keyboardOffer";
import { KNOWLEDGE_ID_IN_TEXT } from "../knowledge";
import { TASK_KEY_IN_TEXT } from "../taskKeys";
import { FRAME_BRIDGE_VERSION, FRAME_LOG_NAME_MAX } from "./bridge";
import { FRAME_ANNOTATION_SCRIPT } from "./frameAnnotationScript";
import { FRAME_EXPAND_SCRIPT } from "./frameExpandScript";
import { FRAME_FIND_SCRIPT } from "./frameFindScript";
import { FRAME_FORM_SCRIPT } from "./frameFormScript";
import { FRAME_HOLD_SCRIPT } from "./frameHoldScript";
import { FRAME_KEYBOARD_SCRIPT } from "./frameKeyboardScript";
import { FRAME_LINK_SCRIPT } from "./frameLinkScript";
import { FRAME_PICTURE_SCRIPT } from "./framePictureScript";
import { FRAME_PRESS_SCRIPT } from "./framePressScript";
import { FRAME_SOUND_SCRIPT } from "./frameSoundScript";
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
 * - `inf.expand(element, state)` - a part marked `data-inf-expand` asks to
 *   open full screen with its state (at most FRAME_EXPAND_STATE_MAX bytes of
 *   JSON), false where the host opens none; `inf.expanded(element)` reads the
 *   state back in the copy, and the part hears the last one as an
 *   `inf-expanded` event (docs/card-authoring.md, "A part full screen").
 * - `inf.stage(name, value, apply?)` - a JSON snapshot staged under a name
 *   beside the body's own form (inline decisions, contract 4.22). It joins
 *   the form's answers, the card's unsent draft included, and is submitted
 *   only with them. `apply(value)` sets the preview's own controls to a
 *   snapshot, as the captain would; the bridge calls it for another
 *   window's setting and one restored at the body's birth, and sends only
 *   what the preview stages back, so a preview that gave none, or whose
 *   apply fails, keeps what it shows.
 *
 * A card body's FORM is the bridge's to watch (inline decisions, contract
 * 4.22): `FRAME_FORM_SCRIPT` (./frameFormScript.ts) starts on the host's
 * `form` message and posts the one-way `answers` message.
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
 * recording: its policy loads no media. `log` is the demo's sibling for a
 * kept proof log (docs/card-authoring.md "Proof logs"): a click on a
 * `data-inf-log` control - or Enter or Space on it, since it is a button -
 * posts the log's served name, the control's words and the size the host
 * wrote, so the host opens it in its log reader over the card; the body never
 * holds the log's text. `draft` is the link's sibling for
 * the app's own message box (FI3-1164): a click on a `data-inf-draft`
 * control - a starter on the welcome - posts its words, one line, which the
 * host puts at the start of the message box, caret after them, sending
 * nothing, and only from a frame that holds the window's focus, as a link
 * opens only then. `ping` / `pong` is the
 * host's liveness probe (the frame watchdog, WI-16): the bridge answers every
 * ping from its message listener, so a frame whose event loop is wedged by a
 * runaway script stops answering and the host tears it down.
 *
 * The bridge's own drawing of a card body's pictures - a picture's Tab
 * stop, a demo's Play button, a diagram as a picture - is
 * `FRAME_PICTURE_SCRIPT` (./framePictureScript.ts).
 *
 * A card body's TASK KEYS and KNOWLEDGE REFERENCES are the bridge's to link
 * once the host names them (`tasks`, `entries`): `FRAME_LINK_SCRIPT`
 * (./frameLinkScript.ts) posts the one-way `task` and `entry` messages.
 *
 * A finger's PRESS held from 0.12 s up, and in Point at any press on a part,
 * acts on its own release: `FRAME_PRESS_SCRIPT` (./framePressScript.ts)
 * clicks what a touch went down on as it comes up there, so a press the
 * browser's own press handling swallows still acts, and drops the browser's
 * own click for a press it already clicked. A phone's host says `press-moved` when its own scroller
 * or swipe took the press, which then does nothing of its own.
 *
 * A card body's KEYBOARD is the bridge's to complete once the host says
 * which of its keys it hears (`keys`): `FRAME_KEYBOARD_SCRIPT`
 * (./frameKeyboardScript.ts) gives focus back and posts the one-way `escape`.
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
 * preparation"): `FRAME_HOLD_SCRIPT` (./frameHoldScript.ts) holds its
 * scripts and animations until the host's `activate`.
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
 * The fragments spliced in (./frame*Script.ts) are part of that text, so a
 * change to any of them moves the hash too.
 */

export const FRAME_BRIDGE_SCRIPT = `(function () {
  var VERSION = ${FRAME_BRIDGE_VERSION};
  var LABEL_MAX = ${CARD_QUESTION_LABEL_MAX};
  var QUESTIONS_MAX_BYTES = ${CARD_QUESTIONS_MAX_BYTES};
  var WRITTEN_MAX = ${CARD_WRITTEN_MAX};
  ${FRAME_ANNOTATION_SCRIPT}
  ${FRAME_FIND_SCRIPT}
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
  var form = { on: false, locked: false, preview: false, fill: null, filling: false, applying: false, staged: {}, appliers: {}, waiting: {}, touched: {}, first: new WeakMap(), last: "", fields: new WeakMap(), current: null };
  var KEY_IN_TEXT = new RegExp(${JSON.stringify(`${TASK_KEY_IN_TEXT}|${KNOWLEDGE_ID_IN_TEXT}`)}, "g");
  var UNLINKED = "a, button, summary, input, select, option, textarea, script, style, svg, [role=button], [data-inf-action], [data-inf-draft], [contenteditable]";
  var keys = { known: null, rested: null, quiet: null, lit: null };
  var entries = { known: null };
  var caps = { pictures: false, escape: false, expand: false, sound: false };
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
${FRAME_HOLD_SCRIPT}
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
${FRAME_EXPAND_SCRIPT}${FRAME_SOUND_SCRIPT}
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
      form.preview = data.preview === true;
      if (hold) hold.form = true;
      else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startForm);
      else startForm();
    } else if (data.type === "fill") {
      // Another window's change to the draft: applied to the body on screen.
      if (form.on && !form.locked && Array.isArray(data.answers)) fillForm(data.answers, true);
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
      caps.expand = data.expand === true;
      caps.sound = data.sound === true;
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tagPictures, { once: true });
      else tagPictures();
    } else if (data.type === "expanded") {
      var back = expandable()[data.index];
      var detail;
      try { detail = back && JSON.parse(data.state); } catch (e) { return; }
      if (back) back.dispatchEvent(new CustomEvent("inf-expanded", { detail: detail }));
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
        // A note on a place opens the viewer at its picture: the host asks which pictures that is.
        var shown = caps.pictures && Number.isSafeInteger(data.picture) && data.picture >= 0 ? partPictureSet(target, data.picture) : null;
        post({ type: "revealed", seq: data.seq, offerId: data.offerId, top: rect.top + window.scrollY, height: rect.height, index: shown ? shown.index : undefined, pictures: shown ? shown.pictures : undefined });
      });
    } else if (data.type === "find-read") {
      if (data.document !== documentId || !Number.isSafeInteger(data.seq) || data.seq < 1) return;
      readFind(data.seq);
    } else if (data.type === "find-mark") {
      if (data.document !== documentId || !Number.isSafeInteger(data.seq) || data.seq < 1 || !Number.isSafeInteger(data.mark) || data.mark < 1) return;
      markFind(data);
    } else if (data.type === "question") {
      if (!Number.isSafeInteger(data.seq) || data.seq < 1) return;
      stepQuestion(data.step === -1 ? -1 : 1, data.unpicked === true, data.wrap === true, data.restart === true, data.keyboard === true, data.seq);
    } else if (data.type === "question-key") {
      pressQuestionKey(data.key, data.shift === true);
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
    } else if (data.type === "text-scale") {
      // A phone's Text Size changed while this page shows: its own rule reads the factor (docs/ios.md, "Text size").
      if (typeof data.scale === "number" && isFinite(data.scale) && data.scale > 0) {
        document.documentElement.style.setProperty("--inf-text-scale", String(data.scale));
      }
    } else if (data.type === "press-moved") {
      // A phone's own scroller or swipe took the finger's press (FRAME_PRESS_SCRIPT).
      pressMoved();
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
    // A part full screen, and its state in the copy (FRAME_EXPAND_SCRIPT).
    expand: expandPart,
    expanded: expandedState,
    stage: function (name, value, apply) {
      var json = value === undefined ? undefined : JSON.stringify(value);
      if (json === undefined) delete form.staged[String(name)];
      else form.staged[String(name)] = json;
      // The function to apply a setting stays until the setting is unstaged.
      if (json === undefined) delete form.appliers[String(name)];
      else if (typeof apply === "function") form.appliers[String(name)] = apply;
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
${FRAME_PICTURE_SCRIPT}
${FRAME_PRESS_SCRIPT}
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
    var log = target && target.closest ? target.closest("[data-inf-log]") : null;
    if (log) {
      event.preventDefault();
      post({
        type: "log",
        src: log.getAttribute("data-inf-log") || "",
        name: (log.textContent || "").replace(/\\s+/g, " ").trim().slice(0, ${FRAME_LOG_NAME_MAX}),
        bytes: Math.max(0, Math.round(Number(log.getAttribute("data-inf-log-bytes"))) || 0)
      });
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
${FRAME_FORM_SCRIPT}
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
${FRAME_LINK_SCRIPT}
${FRAME_KEYBOARD_SCRIPT}
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
export const FRAME_BRIDGE_SHA256 = "sha256-AmlxB+L7UfV4cMOPcrmtjUcfsDdPqGXMhkDcnBuQWmo=";
