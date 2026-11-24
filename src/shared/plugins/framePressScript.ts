/**
 * How long a touch is held before WebKit on an iPhone or iPad hands it from
 * its tap handling to its press handling: the delay of its highlight
 * long-press recognizer, 0.12 s (WKContentViewInteraction's `highlightDelay`).
 * An outside fact the frame cannot read, so it is named here.
 */
export const WEBKIT_HIGHLIGHT_DELAY_MS = 120;

/**
 * Trusted bridge code for a finger's held press (INF-1337), spliced into
 * `FRAME_BRIDGE_SCRIPT` after `FRAME_ANNOTATION_SCRIPT`, whose Point at it
 * reads: a touch or pen press held from 0.12 s up, and in Point at any press
 * on a part, acts on its own trusted release, so a press the browser's own
 * press handling swallows still does what a click there does.
 *
 * On an iPhone or iPad, WebKit hands a touch held 0.12 s or more to its press
 * path, which clicks only if the page has already answered the position
 * request it sends at that moment, and does not once the press is held
 * longer. A held press, more often on a busy card, then reached the page as a
 * pointer going down and up with no click: a picture opened no viewer and a
 * choice stayed unpicked. The pointerup still arrives, trusted.
 *
 * So a press held that long clicks the element it went down on as its pointer
 * comes up there, unless the browser already sent the press's click, and
 * drops the one click the browser may still send for it before the next
 * press or key. A finger's press clicks once its touch has ended too, the
 * moment after its pointerup, so a card's own script that cancels the touch
 * keeps the press.
 *
 * A picture is the one exception. A host opens one only inside a person's
 * user activation, and WebKit gives a press's release one only while the
 * press can still be a tap: one held a second or more holds none. Such a
 * press's click would open nothing, and dropping the browser's own click,
 * which WebKit sends with an activation of its own, would lose the press. So
 * a press on a picture whose release holds no activation stays the
 * browser's, and the phone's hosts keep a held picture from starting a drag
 * or a selection in place of that click (`phonePressRule`).
 *
 * A press the app's own scroller or swipe took is the browser's too. On a
 * phone, the frame's page never scrolls itself: the app's scrollers and
 * swipes move the whole page with the finger, so what the press went down on
 * stays under it, and the browser cancels neither its pointer nor its touch.
 * The app watches the touch on the screen instead and tells the frame
 * `press-moved` once it moves farther than a press may (`pressMoved`), and
 * that press does nothing of its own.
 *
 * In Point at, a press on a part the frame picks acts on its own release
 * however briefly it is held. On a busy phone the app can hand WebKit a
 * quick tap's release late: WebKit's press handling times the touch from
 * when it reached it and takes the tap as held, while the pointer events
 * carry the touch's own times, so the press looks quick to the frame. A held
 * press that WebKit takes clicks only on something that takes clicks of its
 * own, such as a link or a button, never on plain words, so a paragraph
 * pointed at heard no click and opened no note editor. So no clock decides a part pointed at: its release
 * picks it, and the browser's own click, sent or not, is dropped. A
 * selection still standing from before the press goes first, as a tap's own
 * click clears it, so the pick is not kept from the part.
 *
 * Outside Point at, a quicker tap stays the browser's, as it always was. A
 * press that moved off what it went down on, one the browser took for a
 * scroll or a swipe (its pointer or touch cancelled), one whose touch the
 * card's own script cancelled, and one on something that takes its own
 * touches - a text field, a select, a canvas, a media element, a draggable
 * element, or anything under a `touch-action` that is neither `auto` nor
 * `manipulation` - stays the browser's. So does a press outside a control or
 * picture that selected words: holding a finger on text selects it. A
 * mouse's click is untouched.
 */
export const FRAME_PRESS_SCRIPT = `  var press = { held: null, released: null, acted: false };
  var PRESS_OWN = "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]), textarea, select, option, [contenteditable]:not([contenteditable=false]), video, audio, canvas, [draggable=true]";
  var PRESS_CONTROL = "a[href], button, label, summary, input, [role=button], [data-inf-action], [data-inf-draft], [data-inf-log], [data-inf-demo-play], img, svg";
  function takesOwnTouches(element) {
    for (var at = element; at && at.nodeType === 1; at = at.parentElement) {
      var action = getComputedStyle(at).touchAction;
      if (action && action !== "auto" && action !== "manipulation") return true;
    }
    return false;
  }
  function pressMoved() {
    press.held = null;
    press.released = null;
  }
  function pressClick(held, at) {
    var activation = navigator.userActivation;
    if (activation && !activation.isActive && held.target.closest("[data-inf-picture]")) return;
    press.acted = true;
    held.target.dispatchEvent(new MouseEvent("click", {
      bubbles: true, cancelable: true, composed: true, view: window, detail: 1,
      screenX: at.screenX, screenY: at.screenY, clientX: at.clientX, clientY: at.clientY
    }));
  }
  window.addEventListener("pointerdown", function (event) {
    press.acted = false;
    press.held = null;
    press.released = null;
    var target = event.target;
    if (!event.isTrusted || event.pointerType === "mouse" || !event.isPrimary || !target || target.nodeType !== 1) return;
    if (target.closest(PRESS_OWN) || takesOwnTouches(target)) return;
    var control = target.closest(PRESS_CONTROL);
    var points = annotation.enabled && annotation.mode && !!annotationPart(target);
    press.held = { id: event.pointerId, at: event.timeStamp, target: target, area: control || target, control: !!control, points: points, selection: String(getSelection()), clicked: false, touched: false };
  }, true);
  window.addEventListener("pointercancel", function (event) {
    if (press.held && press.held.id === event.pointerId) press.held = null;
  }, true);
  ["touchstart", "touchmove"].forEach(function (type) {
    window.addEventListener(type, function (event) {
      if (!press.held || !event.isTrusted) return;
      if (event.defaultPrevented) press.held = null;
      else press.held.touched = true;
    }, { passive: true });
  });
  window.addEventListener("pointerup", function (event) {
    var held = press.held;
    press.held = null;
    if (!held || !event.isTrusted || event.pointerId !== held.id || held.clicked || !held.target.isConnected) return;
    if (!held.points && event.timeStamp - held.at < ${WEBKIT_HIGHLIGHT_DELAY_MS}) return;
    var under = document.elementFromPoint(event.clientX, event.clientY);
    if (!under || !held.area.contains(under)) return;
    var selection = String(getSelection());
    if (!held.control && selection && selection !== held.selection) return;
    if (held.points && selection) getSelection().removeAllRanges();
    var at = { screenX: event.screenX, screenY: event.screenY, clientX: event.clientX, clientY: event.clientY };
    if (held.touched) press.released = { held: held, at: at };
    else pressClick(held, at);
  }, true);
  window.addEventListener("touchend", function (event) {
    var released = press.released;
    press.released = null;
    if (!released || !event.isTrusted || event.defaultPrevented || released.held.clicked || !released.held.target.isConnected) return;
    pressClick(released.held, released.at);
  }, { passive: true });
  window.addEventListener("touchcancel", function () { press.released = null; }, { passive: true });
  window.addEventListener("click", function (event) {
    if (!event.isTrusted) return;
    if (press.held) press.held.clicked = true;
    if (press.released) press.released.held.clicked = true;
    if (!press.acted) return;
    press.acted = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  window.addEventListener("keydown", function () { press.acted = false; }, true);
`;
