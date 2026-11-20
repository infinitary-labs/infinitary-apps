/** Trusted bridge code: targets and offsets only. Comments never enter this document. */
export const FRAME_ANNOTATION_SCRIPT = `
  var annotation = { enabled: false, mode: false, index: -1, current: null, queued: [], offered: false };
  var annotationControl = 'a,button,input,select,textarea,summary,label,[role=button],[contenteditable],[data-inf-action],[data-inf-draft]';
  function annotationParts() { return Array.from(document.querySelectorAll('[data-inf-target]')).filter(function(el) { return el.getClientRects().length && !el.matches(annotationControl); }); }
  function annotationPart(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el || el.closest(annotationControl)) return null;
    return el.closest('[data-inf-target]');
  }
  function annotationBoundary(el, offset) {
    var walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), node, remaining = offset;
    while ((node = walk.nextNode())) {
      if (remaining <= node.textContent.length) return {node:node,offset:remaining};
      remaining -= node.textContent.length;
    }
    return null;
  }
  function annotationRange(el, span) {
    var last = span.endPart === undefined ? el : document.querySelector('[data-inf-target="' + span.endPart + '"]');
    if (!last) return null;
    var start = annotationBoundary(el,span.start), end = annotationBoundary(last,span.end);
    if (!start || !end) return null;
    var range = document.createRange();range.setStart(start.node,start.offset);range.setEnd(end.node,end.offset);
    return range.collapsed ? null : range;
  }
  function paintAnnotations() {
    document.querySelectorAll('[data-inf-point-lit],[data-inf-point-queued]').forEach(function(el) { el.removeAttribute('data-inf-point-lit'); el.removeAttribute('data-inf-point-queued'); });
    var ranges = [], queued = [];
    function paint(note, pending) {
      var el = document.querySelector('[data-inf-target="' + note.start + '"]');
      if (!el) return;
      if (note.span) { var range = annotationRange(el, note.span); if (range) (pending ? queued : ranges).push(range); }
      else el.setAttribute(pending ? 'data-inf-point-queued' : 'data-inf-point-lit', '');
    }
    annotation.queued.forEach(function(note) { paint(note, true); });
    if (annotation.current) paint(annotation.current, false);
    if (globalThis.CSS && CSS.highlights) {
      CSS.highlights.set('inf-point', new Highlight(...ranges));
      CSS.highlights.set('inf-point-queued', new Highlight(...queued));
    }
  }
  function pickAnnotation(el, span, focusComment) {
    if (!el) return;
    var range = span ? annotationRange(el, span) : null;
    if (span && !range) return;
    var rect = (range || el).getBoundingClientRect();
    var text = range ? range.toString() : el.textContent || el.getAttribute('alt') || el.getAttribute('aria-label') || 'Picture';
    var note = { start: Number(el.getAttribute('data-inf-target')), kind: span ? 'text' : ({P:'paragraph',PRE:'code',BLOCKQUOTE:'quote',LI:'list item',DT:'list item',DD:'list item',TR:'table row',FIGURE:'figure',IMG:'picture',PICTURE:'picture',SVG:'drawing',CANVAS:'drawing',FIELDSET:'question',LABEL:'question',H1:'heading',H2:'heading',H3:'heading',H4:'heading',H5:'heading',H6:'heading'})[el.tagName] || 'question', excerpt: text.slice(0,240) };
    if (span) note.span = span;
    annotation.current = note; paintAnnotations();
    post({ type: 'annotate', document: documentId, target: note, focus: focusComment !== false, box: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } });
  }
  document.addEventListener('pointermove', function(event) {
    // A picked part stays lit while its note editor is open; a click on another part still picks it.
    if (!annotation.enabled || !annotation.mode || annotation.current?.kind || window.getSelection()?.toString()) return;
    var el = annotationPart(event.target);
    annotation.current = el ? { start: Number(el.getAttribute('data-inf-target')) } : null;
    paintAnnotations();
  });
  // A click on a queued note's mark, with Point at off, opens that note; controls keep their own click.
  function queuedMark(event) {
    if (event.target.closest?.(annotationControl)) return null;
    for (var i = 0; i < annotation.queued.length; i++) {
      var note = annotation.queued[i], el = document.querySelector('[data-inf-target="' + note.start + '"]');
      var range = el && note.span ? annotationRange(el, note.span) : null;
      if (range && Array.from(range.getClientRects()).some(function(r) { return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom; })) return { el: el, span: note.span };
    }
    var part = annotationPart(event.target);
    return part && annotation.queued.some(function(note) { return !note.span && note.start === Number(part.getAttribute('data-inf-target')); }) ? { el: part } : null;
  }
  document.addEventListener('click', function(event) {
    if (!annotation.enabled || event.metaKey || event.ctrlKey) return;
    if (window.getSelection()?.toString()) return;
    if (!annotation.mode) {
      var mark = queuedMark(event);
      if (mark) { event.preventDefault(); event.stopImmediatePropagation(); pickAnnotation(mark.el, mark.span, true); }
      return;
    }
    var el = annotationPart(event.target);
    if (!el) return;
    event.preventDefault(); event.stopImmediatePropagation(); pickAnnotation(el);
  }, true);
  function selectedAnnotation(focusComment) {
    if (!annotation.enabled) return false;
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    var range = selection.getRangeAt(0), el = annotationPart(range.startContainer);
    var last = annotationPart(range.endContainer);
    if (!el || !last) return false;
    var prefix = document.createRange(); prefix.selectNodeContents(el); prefix.setEnd(range.startContainer,range.startOffset);
    var start = prefix.toString().length;
    prefix.selectNodeContents(last); prefix.setEnd(range.endContainer,range.endOffset);
    var span = {start:start,end:prefix.toString().length};
    if (last !== el) span.endPart = Number(last.getAttribute('data-inf-target'));
    annotation.offered = focusComment !== true;
    pickAnnotation(el, span, focusComment === true);
    return true;
  }
  document.addEventListener('pointerup', function() { selectedAnnotation(); });
  document.addEventListener('keyup', function(event) { if (event.shiftKey) selectedAnnotation(); });
  // A press in the card closes the host's note editor and Annotate offer, keeping the note's words.
  document.addEventListener('pointerdown', function(event) { if (event.isTrusted && annotation.enabled) post({ type: 'pointer-down', document: documentId }); }, true);
  // The host's Annotate offer leaves with the selection it was offered for.
  document.addEventListener('selectionchange', function() {
    if (annotation.offered && window.getSelection()?.isCollapsed !== false) { annotation.offered = false; post({ type: 'selection-cleared', document: documentId }); }
  });
  document.addEventListener('keydown', function(event) {
    if (annotation.enabled && window.getSelection()?.toString() && !event.target.closest?.(annotationControl) && (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) && selectedAnnotation(true)) {
      event.preventDefault(); event.stopImmediatePropagation();
      return;
    }
    if (!annotation.enabled || !annotation.mode || event.target.closest?.(annotationControl)) return;
    var parts = annotationParts();
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault(); event.stopImmediatePropagation();
      annotation.index = Math.max(0, Math.min(parts.length - 1, annotation.index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1)));
      var el = parts[annotation.index];
      if (el) { annotation.current = {start:Number(el.getAttribute('data-inf-target'))}; paintAnnotations(); el.scrollIntoView({block:'nearest'}); }
    } else if (event.key === 'Enter') {
      event.preventDefault(); event.stopImmediatePropagation(); pickAnnotation(parts[annotation.index] || parts[0]);
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); annotation.mode = false; annotation.current = null; paintAnnotations(); post({type:'point-exit',document:documentId});
    }
  }, true);
  // A lit part is a rounded tint reaching 4 px past its words on every side, inside the body's 4 px inset (the
  // card's own padding, here given to its top and foot too), so no edge cuts it and lighting moves no text; a queued
  // part's 2 px bar sits in that inset, left of its words. The Mac and the phone draw both alike (INF-3746).
  var annotationStyle = document.createElement('style');
  annotationStyle.textContent = 'body:has([data-inf-target]){padding-block:var(--space-1)}[data-inf-point-lit]{background:var(--accent-dim)!important;border-radius:var(--radius-xs);box-shadow:0 0 0 3px var(--accent-dim),0 0 0 4px var(--line-2)}[data-inf-point-queued]{position:relative}[data-inf-point-queued]::before{content:"";position:absolute;left:calc(-1 * var(--space-1));top:2px;bottom:2px;width:2px;border-radius:2px;background:var(--accent);pointer-events:none}img[data-inf-point-queued]{box-shadow:-4px 0 0 -2px var(--accent)}::highlight(inf-point),::highlight(inf-point-reveal){background:var(--accent-dim);text-decoration:underline;text-decoration-color:var(--accent)}::highlight(inf-point-queued){text-decoration:underline;text-decoration-color:var(--accent);text-decoration-thickness:2px}';
  document.head.appendChild(annotationStyle);
`;
