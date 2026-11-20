/**
 * Trusted bridge code for a part full screen (docs/card-authoring.md,
 * "A part full screen"), spliced into `FRAME_BRIDGE_SCRIPT`: `inf.expand` and
 * `inf.expanded`, and `fillWindow(part)`, which fixes the part to the window and
 * turns two fingers on a touch screen into the scroll and pinch a trackpad
 * sends.
 */
import { FRAME_EXPAND_STATE_MAX } from "./bridge";

export const FRAME_EXPAND_SCRIPT = `  var expandable = function () { return Array.prototype.slice.call(document.querySelectorAll("[data-inf-expand]")); };
  // inf.expand: false when the host opens none or the state is too large.
  var expandPart = function (element, value) {
    var index = expandable().indexOf(element);
    if (!caps.expand || index < 0) return false;
    var json = JSON.stringify(value === undefined ? null : value);
    if (new TextEncoder().encode(json).length > ${FRAME_EXPAND_STATE_MAX}) return false;
    post({ type: "expand", index: index, state: json });
    return true;
  };
  // inf.expanded: in the full-screen copy, the state the part opened with; null anywhere else.
  var expandedState = function (element) {
    var stamp = document.querySelector("[data-inf-expanded]");
    if (!stamp) return null;
    try {
      var opened = JSON.parse(stamp.getAttribute("data-inf-expanded"));
      if (!opened || opened.index !== expandable().indexOf(element)) return null;
      fillWindow(element);
      return opened.state;
    } catch (e) {
      return null;
    }
  };
  // A part's full-screen copy (stamped data-inf-expanded), once the part
  // reads its state back: only that part shows, fixed to the window edge to
  // edge, and the rest of the body leaves the screen and the Tab order. On a
  // touch screen the part takes every finger; two fingers reach it as a
  // trackpad pinch does, as Ctrl-scroll at their middle, and their moving
  // together as a plain scroll (docs/card-authoring.md, "A part full screen").
  var filled = false;
  var fillWindow = function (part) {
    if (filled) return;
    filled = true;
    var hideRest = function () {
      for (var at = part; at !== document.body && at.parentElement; at = at.parentElement) {
        Array.prototype.forEach.call(at.parentElement.children, function (other) {
          if (other !== at && !/^(SCRIPT|STYLE)$/.test(other.tagName)) { other.inert = true; other.hidden = true; }
        });
      }
    };
    hideRest();
    // A part's own inline script runs before the body after it is read:
    // that rest leaves once the whole body is in.
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hideRest, { once: true });
    Object.assign(part.style, { position: "fixed", inset: "0", margin: "0", border: "0", borderRadius: "0", touchAction: "none" });
    var fingers = new Map();
    var last = null;
    var wheel = function (init) {
      var under = document.elementFromPoint(init.clientX, init.clientY);
      (under && part.contains(under) ? under : part).dispatchEvent(new WheelEvent("wheel", Object.assign({ bubbles: true, cancelable: true }, init)));
    };
    var track = function (event) {
      if (event.pointerType !== "touch") return;
      if (event.type === "pointerup" || event.type === "pointercancel") fingers.delete(event.pointerId);
      else if (event.type === "pointerdown" || fingers.has(event.pointerId)) fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (fingers.size !== 2) { last = null; return; }
      var two = Array.from(fingers.values());
      var now = { d: Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y) || 1, x: (two[0].x + two[1].x) / 2, y: (two[0].y + two[1].y) / 2 };
      if (last) {
        wheel({ clientX: now.x, clientY: now.y, deltaX: last.x - now.x, deltaY: last.y - now.y });
        wheel({ clientX: now.x, clientY: now.y, ctrlKey: true, deltaY: -100 * Math.log(now.d / last.d) });
      }
      last = now;
    };
    ["pointerdown", "pointermove", "pointerup", "pointercancel"].forEach(function (type) { listen.call(part, type, track, true); });
  };`;
