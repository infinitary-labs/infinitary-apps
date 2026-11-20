import { FRAME_FIND_TEXT_MAX } from "./bridge";

/**
 * Trusted bridge code for finding words in the shown card (⌘F; docs/keyboard.md,
 * "Finding in the shown card"). The words the person typed never enter this
 * document: on `find-read` the bridge hands out the words the page shows, in
 * reading order, and on `find-mark` the host sends back only where the
 * matches are, as offsets into those words. The bridge draws them with the
 * CSS Custom Highlight API, never in the markup, opens a closed folded
 * section that holds the current match, and answers with that match's box.
 *
 * What counts as shown: every visible text node outside script, style, a
 * field's value and a template, that lays out, or that would once the closed
 * folded sections holding it open; words hidden on their own, which no
 * opening shows, never count. A change of block between two text nodes is marked with a
 * character no typed words hold, so a match never runs from one paragraph
 * into the next. The host reads offsets in UTF-16 units, as here.
 */
export const FRAME_FIND_SCRIPT = `
  var finding = { seq: 0, nodes: [], starts: [] };
  var FIND_SKIP = "script,style,textarea,select,option,noscript,template";
  var FIND_BLOCK = "p,li,dt,dd,td,th,pre,h1,h2,h3,h4,h5,h6,summary,figcaption,blockquote,legend,label,caption,text,foreignObject,div,section,article,aside,header,footer,nav,main,figure,details,fieldset,table,tr,ul,ol,dl,button";
  function findShown(element) {
    if (element.closest(FIND_SKIP)) return false;
    if (getComputedStyle(element).visibility !== "visible") return false;
    // Outward from the words: every box on the way is drawn, or only kept
    // from drawing by a closed folded section, up to one that is drawn.
    var folded = false;
    for (var at = element; at; at = at.parentElement) {
      if (getComputedStyle(at).display === "none") return false;
      if (at.getClientRects().length) return at === element || folded;
      var fold = at.parentElement;
      if (fold && fold.tagName === "DETAILS" && !fold.open && at.tagName !== "SUMMARY") folded = true;
    }
    return false;
  }
  function readFind(seq) {
    var walk = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    var node, text = "", nodes = [], starts = [], block = null, shown = new Map();
    while ((node = walk.nextNode())) {
      var element = node.parentElement;
      if (!element || !node.data) continue;
      var ok = shown.get(element);
      if (ok === undefined) { ok = findShown(element); shown.set(element, ok); }
      if (!ok) continue;
      var at = element.closest(FIND_BLOCK);
      if (nodes.length && at !== block) text += "\\u0000";
      block = at;
      nodes.push(node);
      starts.push(text.length);
      text += node.data;
      if (text.length > ${FRAME_FIND_TEXT_MAX}) break;
    }
    finding = { seq: seq, nodes: nodes, starts: starts };
    post({ type: "find-text", seq: seq, text: text.slice(0, ${FRAME_FIND_TEXT_MAX}) });
  }
  function findRanges(spans) {
    var ranges = [], nodes = finding.nodes, starts = finding.starts, i = 0, last = -1;
    for (var k = 0; k < spans.length; k++) {
      var span = spans[k], range = null;
      if (Array.isArray(span) && Number.isSafeInteger(span[0]) && Number.isSafeInteger(span[1]) && span[1] > span[0]) {
        if (span[0] < last) i = 0;
        last = span[0];
        while (i < nodes.length && starts[i] + nodes[i].data.length <= span[0]) i++;
        var j = i;
        while (j < nodes.length && starts[j] + nodes[j].data.length < span[1]) j++;
        if (j < nodes.length && span[0] >= starts[i] && span[1] > starts[j] && nodes[i].isConnected && nodes[j].isConnected) {
          range = document.createRange();
          try { range.setStart(nodes[i], span[0] - starts[i]); range.setEnd(nodes[j], span[1] - starts[j]); } catch (e) { range = null; }
          if (range && range.collapsed) range = null;
        }
      }
      ranges.push(range);
    }
    return ranges;
  }
  function clearFind() {
    if (globalThis.CSS && CSS.highlights) { CSS.highlights.delete("inf-find"); CSS.highlights.delete("inf-find-current"); }
  }
  function markFind(data) {
    if (!Array.isArray(data.spans) || !data.spans.length) { clearFind(); finding = { seq: 0, nodes: [], starts: [] }; post({ type: "found", seq: data.seq, mark: data.mark }); return; }
    if (data.seq !== finding.seq) { post({ type: "found", seq: data.seq, mark: data.mark }); return; }
    // The matches of one read are resolved and drawn once, in one pass; a
    // step to another match only moves the current one, drawn above them.
    if (!finding.ranges || finding.ranges.length !== data.spans.length) {
      finding.ranges = findRanges(data.spans);
      if (globalThis.CSS && CSS.highlights) {
        var every = new Highlight();
        finding.ranges.forEach(function (range) { if (range) every.add(range); });
        CSS.highlights.set("inf-find", every);
      }
    }
    var current = Number.isSafeInteger(data.current) && data.current >= 0 ? finding.ranges[data.current] || null : null;
    if (globalThis.CSS && CSS.highlights) {
      var lit = new Highlight();
      if (current) lit.add(current);
      lit.priority = 1;
      CSS.highlights.set("inf-find-current", lit);
    }
    if (!current) { post({ type: "found", seq: data.seq, mark: data.mark }); return; }
    var opened = false, ancestor = current.startContainer.parentElement;
    while (ancestor) { if (ancestor.tagName === "DETAILS" && !ancestor.open) { ancestor.open = true; opened = true; } ancestor = ancestor.parentElement; }
    if (opened) resize();
    requestAnimationFrame(function () {
      var rect = current.getBoundingClientRect();
      post({ type: "found", seq: data.seq, mark: data.mark, top: Math.max(0, rect.top + window.scrollY), height: Math.max(0, rect.height) });
    });
  }
  var findStyle = document.createElement("style");
  findStyle.textContent = "::highlight(inf-find){background:var(--accent-dim)}::highlight(inf-find-current){background:var(--accent);color:var(--bg-0)}";
  document.head.appendChild(findStyle);
`;
