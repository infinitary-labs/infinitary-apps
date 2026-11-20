/**
 * Trusted bridge code for a card body's keyboard, spliced into
 * `FRAME_BRIDGE_SCRIPT` (./frameScript.ts), whose message listener hears
 * the host's `keys`, `focus` and `move`, the last a movement command's key
 * (docs/keyboard.md, "Moving by a key of your own"). The Tab stop a picture
 * takes is `tagPictures()` in ./framePictureScript.ts.
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
 */
export const FRAME_KEYBOARD_SCRIPT = `  // The keyboard rests on a key as the pointer does, and leaving it lets go.
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
  });`;
