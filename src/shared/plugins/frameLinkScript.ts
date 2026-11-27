/**
 * Trusted bridge code for the task keys and knowledge references a card
 * body writes, spliced into `FRAME_BRIDGE_SCRIPT` (./frameScript.ts), whose
 * message listener hears which ones the host knows. Its one watch of the
 * document also tags the pictures and draws the demos a change adds
 * (./framePictureScript.ts).
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
 * Its ADDRESSES written as words are linked on a card's mount alone, once the
 * host's `keys` message says `addresses` (INF-7045): each https address, and
 * each http one to this computer, that src/shared/linkify.ts counts and the
 * safe opener takes, becomes `<a href data-inf-address>` with the address as
 * written for its words, its trailing punctuation left outside. Addresses
 * link first, so a key inside an address stays part of it, and where keys do
 * (the same skip list, a choice's label included), at load and again whenever
 * the document changes. A press on one is any link's: the bridge's click
 * handler posts `link`, and the host opens it only from the captain's own
 * press.
 */
export const FRAME_LINK_SCRIPT = `  function keyLink(target) {
    return target && target.closest ? target.closest("a[data-inf-task]") : null;
  }
  function entryLink(target) {
    return target && target.closest ? target.closest("a[data-inf-entry]") : null;
  }
  // The address the words start with, its trailing punctuation and any
  // closing bracket it did not open left out (linkify's trimTrailingUrlPunctuation).
  function addressIn(raw) {
    var address = raw;
    while (address.length > 0) {
      var last = address.charAt(address.length - 1);
      var opener = Object.prototype.hasOwnProperty.call(ADDRESS_CLOSERS, last) ? ADDRESS_CLOSERS[last] : null;
      if (ADDRESS_TRAILING.indexOf(last) < 0 && !(opener && unmatched(address, opener, last))) break;
      address = address.slice(0, -1);
    }
    return address;
  }
  function unmatched(value, open, close) {
    var depth = 0;
    for (var i = 0; i < value.length; i++) {
      if (value.charAt(i) === open) depth += 1;
      else if (value.charAt(i) === close) depth -= 1;
    }
    return depth < 0;
  }
  // The safe opener's rule (linkify's isSafeCardHref): an address it would refuse stays words.
  function opens(address) {
    var url;
    try { url = new URL(address); } catch (e) { return false; }
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    var host = url.hostname.toLowerCase();
    return LOOPBACK_HOSTS.indexOf(host) >= 0 || host.slice(-LOCALHOST_SUFFIX.length) === LOCALHOST_SUFFIX;
  }
  // Links the addresses in a text node; answers the text nodes left around them.
  function linkAddresses(node) {
    var text = node.nodeValue;
    var parts = null;
    var rest = [];
    var at = 0;
    var match;
    ADDRESS_IN_TEXT.lastIndex = 0;
    while ((match = ADDRESS_IN_TEXT.exec(text))) {
      var address = addressIn(match[0]);
      if (!address || !opens(address)) continue;
      parts = parts || document.createDocumentFragment();
      if (match.index > at) rest.push(parts.appendChild(document.createTextNode(text.slice(at, match.index))));
      var link = document.createElement("a");
      link.setAttribute("href", address);
      link.setAttribute("data-inf-address", "");
      link.textContent = address;
      parts.appendChild(link);
      at = match.index + address.length;
    }
    if (!parts) return [node];
    if (at < text.length) rest.push(parts.appendChild(document.createTextNode(text.slice(at))));
    node.parentNode.replaceChild(parts, node);
    return rest;
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
  function linkWords() {
    var named = keys.known || entries.known;
    if ((!named && !addresses.on) || !document.body) return;
    var found = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var words = node.nodeValue;
      if (!(named && words.indexOf("-") >= 0) && !(addresses.on && words.indexOf("://") >= 0)) continue;
      if (!node.parentElement || node.parentElement.closest(UNLINKED)) continue;
      found.push(node);
    }
    var linked = false;
    found.forEach(function (text) {
      var rest = addresses.on ? linkAddresses(text) : [text];
      if (rest[0] !== text) linked = true;
      if (named) rest.forEach(function (part) { if (linkText(part)) linked = true; });
    });
    if (!linked) return;
    markLit();
    // The same words in the same place: linking is not the body changing.
    sizeWatch.takeRecords();
    keyWatch.takeRecords();
    resize();
  }
  var keyWatch = new MutationObserver(function () {
    if (keys.known || entries.known || addresses.on) linkWords();
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
  }, true);`;
