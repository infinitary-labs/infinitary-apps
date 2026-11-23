  // ---- camera: fit, zoom and pan, all on your input
  function bounds() {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const grow = (a, b, c, d) => {
      x0 = Math.min(x0, a);
      y0 = Math.min(y0, b);
      x1 = Math.max(x1, c);
      y1 = Math.max(y1, d);
    };
    for (const n of V.nodes) grow(n.x - n.w / 2, n.y - n.h / 2 - 18, n.x + n.w / 2, n.y + n.h / 2);
    if (V.frame) grow(V.frame.x, V.frame.y, V.frame.x + V.frame.w, V.frame.y + V.frame.h);
    const shown = (e) => !(V.busy && e.el && e.el.classList.contains("thin"));
    for (const e of V.edges) if (e.lx && e.lab && e.lab.classList.contains("named")) grow(...e.lx);
    for (const e of V.edges)
      if (e.lane !== undefined && shown(e)) grow(e.a.x, e.lane - 4, e.b.x, e.lane + 4);
    for (const e of V.edges)
      if (same(e) && !e.down && shown(e))
        grow(
          e.a.x,
          Math.min(e.a.y, e.b.y),
          Math.max(e.a.x + e.a.w / 2, e.b.x + e.b.w / 2) + 40,
          Math.max(e.a.y, e.b.y),
        );
    for (const e of V.edges)
      if (e.back && !same(e) && shown(e))
        grow(Math.min(e.a.x, e.b.x), backY(e) - 8, Math.max(e.a.x, e.b.x), backY(e) + 8);
    return [x0, y0, x1, y1];
  }
  function fit() {
    const [x0, y0, x1, y1] = bounds();
    // on a touch screen the diagram is as tall as the drawing fitted to the card's width
    if (touch && !full) {
      const kw = Math.min(1.25, (W() - 32) / (x1 - x0));
      svg.style.height = `${Math.max(150, Math.min(290, (y1 - y0) * kw + 64))}px`;
    }
    const k = Math.min(1.25, (W() - 40) / (x1 - x0), (H() - 40) / (y1 - y0));
    cam.k = k;
    cam.x = (x0 + x1) / 2 - W() / k / 2;
    cam.y = (y0 + y1) / 2 - H() / k / 2;
    apply();
  }
  function zoom(f, px, py) {
    const k = Math.max(0.15, Math.min(4, cam.k * f));
    const wx = cam.x + (px ?? W() / 2) / cam.k;
    const wy = cam.y + (py ?? H() / 2) / cam.k;
    cam.k = k;
    cam.x = wx - (px ?? W() / 2) / k;
    cam.y = wy - (py ?? H() / 2) / k;
    apply();
  }
  function show(ref) {
    V = viewOf(ref);
    sizeBoxes(V);
    if (V.frame) grid(V);
    else framed(V);
    sel = null;
    draw();
    fit();
    crumbs();
    list();
    counter();
  }
  function go(path, from) {
    stack = path;
    scene.style.transition = "";
    show(path[path.length - 1]);
    if (from) {
      const back = V.nodes.find((n) => n.ref === from || (n.ref && n.ref.sub === from));
      if (back) {
        sel = back;
        mark();
      }
    }
    if (!reduce) {
      scene.style.opacity = 0;
      requestAnimationFrame(() => {
        scene.style.transition = "opacity var(--dur-med, 180ms)";
        scene.style.opacity = 1;
      });
    }
  }
  // where a place sits: the levels and groups around it, from the top
  const holderPath = (P) => (P.g && P.lvl.groups.length ? [...pathTo(P.lvl), P.g] : pathTo(P.lvl));
  function pathTo(x) {
    if (x.kind === "lvl") return x.part ? [...holderPath(x.part), x] : [x];
    if (x.kind === "grp") return [...pathTo(x.lvl), x];
    if (x.kind === "part") return [...holderPath(x), x];
    if (x.kind === "mach")
      return x.holder ? [...pathTo(x.holder.sub || x.holder), x] : [...pathTo(x.lvl), x];
    return [top];
  }
  function enter(n) {
    if (!n || !opens(n)) return;
    const r = n.ref;
    if (n.kind === "ext" || n.kind === "state") {
      go(pathTo(r.kind === "grp" ? r : placeOf(r)));
      return;
    }
    go([...stack, placeOf(r)]);
  }
  function upOne() {
    if (stack.length > 1) go(stack.slice(0, -1), stack[stack.length - 1]);
  }

  const hit = (ev) => {
    for (let t = ev.target; t && t !== svg; t = t.parentNode) if (t._n) return t._n;
    return null;
  };
  const hitM = (ev) => {
    for (let t = ev.target; t && t !== svg; t = t.parentNode) if (t._m) return t._m;
    return null;
  };
  let drag = null;
  let downOn = null;
  // a finger's tap on the map in a card, waiting for its click to open full screen
  let tapped = false;
  svg.addEventListener("pointerdown", (ev) => {
    if (ev.button) return;
    // a second finger is a pinch, which the card's bridge hands over as ⌘-scroll: no drag, no tap
    if (drag?.finger && ev.pointerType === "touch") {
      drag = null;
      return;
    }
    // the box is read on the way down: once the pointer is captured, the release lands on the map
    downOn = hit(ev);
    const finger = ev.pointerType === "touch";
    if (!finger) svg.focus({ preventScroll: true });
    drag = {
      x: ev.clientX,
      y: ev.clientY,
      cx: cam.x,
      cy: cam.y,
      moved: false,
      finger,
      n: downOn,
      m: hitM(ev),
    };
    // in a card a finger is never captured, so it scrolls the card; a mouse drags the map
    if (!finger) svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > (drag.finger ? 8 : 3)) drag.moved = true;
    if (!drag.moved || (drag.finger && !full)) return;
    cam.x = drag.cx - dx / cam.k;
    cam.y = drag.cy - dy / cam.k;
    apply();
  });
  svg.addEventListener("pointercancel", () => {
    drag = null;
  });
  svg.addEventListener("pointerup", () => {
    const d = drag;
    drag = null;
    if (!d || d.moved) return;
    // in a card on a touch screen the diagram is a picture: a tap opens it full screen, on the click
    // the tap makes, since a phone's browser hands its frame the focus and the press only by then
    tapped = d.finger && !full;
    if (tapped) return;
    if (d.m) go(pathTo(d.m));
    // full screen, a tap on the chosen box goes in, as a double-click does
    else if (d.finger && d.n && d.n === sel && opens(d.n)) enter(d.n);
    else {
      sel = d.n;
      mark();
    }
  });
  // the map takes its own presses, and opens full screen on a finger's tap in a card
  svg.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (tapped && !full) fullScreen();
    tapped = false;
  });
  // the double-click lands on the map too, so it opens the box the second press went down on
  svg.addEventListener("dblclick", (ev) => {
    if (!touch) enter(hit(ev) || downOn);
  });
  // a plain scroll is the card's, so it scrolls past the map; a pinch or ⌘- or Ctrl-scroll zooms at the pointer
  svg.addEventListener(
    "wheel",
    (ev) => {
      // full screen there is no card to scroll: a plain scroll moves the map
      if (!ev.ctrlKey && !ev.metaKey && !full) return;
      ev.preventDefault();
      if (!ev.ctrlKey && !ev.metaKey) {
        cam.x += ev.deltaX / cam.k;
        cam.y += ev.deltaY / cam.k;
        return apply();
      }
      const r = svg.getBoundingClientRect();
      zoom(
        Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.002)),
        ev.clientX - r.left,
        ev.clientY - r.top,
      );
    },
    { passive: false },
  );
  // bring the chosen box or link into view, and closer when the map is drawn too small to read
  function reveal(target) {
    if (!target || (touch && !full)) return;
    const n = target._n;
    const b = n
      ? { x: n.x - n.w / 2, y: n.y - n.h / 2, width: n.w, height: n.h }
      : target.getBBox();
    const vw = () => W() / cam.k;
    const vh = () => H() / cam.k;
    const x1 = b.x + b.width;
    const y1 = b.y + b.height;
    if (cam.k >= 0.6 && b.x >= cam.x && x1 <= cam.x + vw() && b.y >= cam.y && y1 <= cam.y + vh())
      return;
    if (cam.k < 0.6) cam.k = Math.min(1, (W() - 40) / b.width, (H() - 40) / b.height);
    cam.x = b.x + b.width / 2 - vw() / 2;
    cam.y = b.y + b.height / 2 - vh() / 2;
    apply();
  }
  const step = (dx, dy) => {
    const ns = V.nodes;
    if (!sel) {
      sel = [...ns].sort((a, b) => a.x - b.x || a.y - b.y)[0] || null;
      return;
    }
    let best = null;
    let bs = Infinity;
    for (const n of ns) {
      if (n === sel) continue;
      const vx = n.x - sel.x;
      const vy = n.y - sel.y;
      const along = vx * dx + vy * dy;
      if (along <= 1) continue;
      const s = along + 2.5 * Math.abs(vx * dy - vy * dx);
      if (s < bs) {
        bs = s;
        best = n;
      }
    }
    if (best) sel = best;
  };
  // Full screen: the diagram whole, as it stands, goes to the app's picture viewer as a still picture
  function still() {
    const [x0, y0, x1, y1] = bounds();
    const was = [svg.getAttribute("viewBox"), svg.getAttribute("aria-label")];
    svg.setAttribute("viewBox", `${x0 - 24} ${y0 - 24} ${x1 - x0 + 48} ${y1 - y0 + 48}`);
    svg.setAttribute(
      "aria-label",
      `${stack.map(nameOf).join(" › ")}${cmp >= 0 ? `, with ${CMP[cmp].label}` : ""}: ${liveEl.textContent}`,
    );
    // the card's bridge (window.inf) copies the drawing at once; a page with none opens nothing
    window.inf?.picture?.(svg);
    svg.setAttribute("viewBox", was[0]);
    svg.setAttribute("aria-label", was[1]);
  }
  // Full screen: the app opens this body again over its window, the map live in it at this state;
  // a host that opens none gets the still picture
  function fullScreen() {
    if (full) return;
    // focus comes back to Full screen when the full-screen map closes
    if (!touch) fsBtn.focus({ preventScroll: true });
    if (!window.inf?.expand?.(root, stateNow())) still();
  }
  svg.addEventListener("keydown", (ev) => {
    const k = ev.key;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // full screen, Escape is the app's: it closes the full-screen map at once
    if (full && k === "Escape") return;
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[k]) {
      step(...arrows[k]);
      mark();
      if (sel) reveal(sel.el);
    } else if (k === "Enter") enter(sel);
    else if (k === "Escape" || k === "Backspace") {
      // at the top with nothing chosen, Escape is left for the card around the map
      if (!sel && !hot && stack.length < 2) return;
      if (sel || hot) {
        sel = null;
        hot = null;
        mark();
      } else upOne();
    } else if (k === "+" || k === "=") zoom(1.25);
    else if (k === "-") zoom(0.8);
    else if (k === "0") fit();
    else if ((k === "f" || k === "F") && !full) fullScreen();
    else if (k === "]" && cmp >= 0) stepTo(at + 1);
    else if (k === "[" && cmp >= 0) stepTo(at < 0 ? -1 : at - 1);
    else return;
    ev.preventDefault();
  });
  const press = (q, f) => {
    $(q).onclick = f;
  };
  press("[data-up]", upOne);
  press("[data-fit]", fit);
  press("[data-zo]", () => zoom(0.8));
  press("[data-zi]", () => zoom(1.25));
  press("[data-fs]", fullScreen);
  press("[data-open]", () => enter(sel));
  press("[data-next]", () => stepTo(at + 1));
  press("[data-prev]", () => stepTo(at < 0 ? -1 : at - 1));
  press("[data-more]", () => {
    moreEl.hidden = !moreEl.hidden;
    moreBtn.setAttribute("aria-expanded", String(!moreEl.hidden));
  });
  $("[data-keys]").textContent = touch
    ? ""
    : `Click or arrows choose · Enter goes in · ${full ? "Backspace up · [ ] step through changes · scroll moves · ⌘-scroll zooms · Esc closes" : "Esc back · [ ] step through changes · ⌘-scroll zooms · F full screen"}`;
  // a comparison opens at the deepest level that still holds every change
  const where = () => {
    let P = null;
    const meet = (q) => {
      if (!P) P = q;
      else {
        let i = 0;
        while (i < P.length && P[i] === q[i]) i++;
        P = P.slice(0, i);
      }
    };
    const levels = [];
    const walk = (L) => {
      levels.push(L);
      for (const Q of L.parts) if (Q.sub) walk(Q.sub);
    };
    walk(top);
    for (const Q of parts) if (Q.fl.length) meet(pathTo(Q.sub || Q));
    for (const L of levels) {
      for (const Q of L.gp) meet(Q.g ? pathTo(Q.g) : pathTo(L));
      for (const l of [...L.links.filter((x) => x.st && x.st !== "="), ...L.gl])
        meet(l.a.g && l.a.g === l.b.g ? pathTo(l.a.g) : pathTo(L));
      for (const G of L.gm) meet(pathTo(G));
    }
    for (const M of machs) if (M.st) meet(pathTo(M));
    return P && P.length ? P : [top];
  };
  const cmpEl = $("[data-cmps]");
  // one toggle per comparison: pressed shows what it changed, pressed again shows the map alone
  const cmpBtns = [...CMP.keys()].map((i) => {
    const label = CMP[i].label || `Comparison ${i + 1}`;
    const b = mk("button", label, cmpEl);
    b.setAttribute("aria-pressed", "false");
    b.onclick = () => turn(cmp === i ? -1 : i);
    return b;
  });
  const pressed = () => {
    for (const [j, x] of cmpBtns.entries()) x.setAttribute("aria-pressed", String(j === cmp));
  };
  cmpEl.hidden = !CMP.length;
  function turn(i) {
    compare(i);
    pressed();
    if (cmp >= 0) return go(where());
    // a place that only the comparison drew is gone now, so the view climbs to one that is still there
    const gone = (x) => x.gone || (x.kind === "part" && !opensPart(x));
    let path = stack;
    while (path.length > 1 && gone(path[path.length - 1])) path = path.slice(0, -1);
    go(path);
  }
  // a narrow card puts the comparison buttons under More; full screen, a new height refits too
  let wide = 0;
  let tall = 0;
  new ResizeObserver(() => {
    if (root.clientWidth === wide && (!full || root.clientHeight === tall)) return;
    wide = root.clientWidth;
    tall = root.clientHeight;
    const narrow = wide < 560;
    root.classList.toggle("narrow", narrow);
    (narrow ? $("[data-mcmp]") : $(".bar")).insertBefore(cmpEl, narrow ? null : $(".zoom"));
    if (V) fit();
  }).observe(root);
  const open = D.open || {};
  // the problems listed are the map files' own: an older file a comparison reads is history
  const listed = [...bad];
  if (Number.isInteger(open.changes) && CMP[open.changes]) {
    compare(open.changes);
    pressed();
  }
  // a part or machine the open comparison removed is a place too, while that comparison is on
  function removedPlace(L) {
    const G = L.gm.find((M) => M.name === open.at);
    if (G) return G;
    const Q = L.gp.find((P) => P.path === open.at);
    if (Q) return Q.g || L;
    for (const P of L.parts) {
      const x = P.sub && removedPlace(P.sub);
      if (x) return x;
    }
    return null;
  }
  const startAt =
    open.at === undefined
      ? null
      : open.at === ""
        ? top
        : byPath[open.at]
          ? placeOf(byPath[open.at])
          : machByName[open.at] || (cmp >= 0 && removedPlace(top)) || null;
  if (open.at !== undefined && !startAt)
    listed.push(`"open" names ${open.at}, which is not a part's folder or a machine on the map.`);
  if (listed.length) {
    badEl.hidden = false;
    mk(
      "p",
      listed.length === 1
        ? "This map has a problem to fix in its map files:"
        : `This map has ${listed.length} problems to fix in its map files:`,
      badEl,
    );
    const ul = mk("ul", "", badEl);
    for (const t of listed.slice(0, 8)) mk("li", t, ul);
    if (listed.length > 8) mk("li", `and ${listed.length - 8} more`, ul);
  }
  // where the map stands, as keys that name each place on the way down, for the full-screen map and back
  function keyOf(x) {
    if (x.kind === "lvl") return `L:${x.folder}`;
    if (x.kind === "grp") return `G:${x.lvl.folder}/${x.name}`;
    return x.kind === "part" ? `P:${x.path}` : `M:${x.name}`;
  }
  function byKey(k) {
    const walk = (L) =>
      [L, ...L.groups, ...partsOf(L), ...L.machs, ...(cmp < 0 ? [] : L.gm)].find(
        (x) => keyOf(x) === k,
      ) || L.parts.reduce((y, P) => y || (P.sub && walk(P.sub)), null);
    return typeof k === "string" ? walk(top) : null;
  }
  function stateNow() {
    return { place: stack.map(keyOf), changes: cmp, chosen: sel ? sel.key : null, step: at };
  }
  function goToState(t) {
    if (!t || typeof t !== "object") return;
    const c = Number.isInteger(t.changes) && CMP[t.changes] ? t.changes : -1;
    if (c !== cmp) {
      compare(c);
      pressed();
    }
    const path = Array.isArray(t.place) ? t.place.map(byKey) : [];
    const last = path.filter(Boolean).pop();
    go(
      path.length && path.every(Boolean) ? path : last ? pathTo(last) : cmp >= 0 ? where() : [top],
    );
    if (Number.isInteger(t.step) && t.step >= 0 && items[t.step]) stepTo(t.step);
    else {
      sel = V.nodes.find((n) => n.key === t.chosen) || null;
      mark();
      if (sel) reveal(sel.el);
    }
  }
  // the full-screen map closed: this one goes where it was left
  root.addEventListener("inf-expanded", (ev) => goToState(ev.detail));
  if (full) {
    goToState(opened);
    const keys = () =>
      document.activeElement === document.body && svg.focus({ preventScroll: true });
    keys();
    window.addEventListener("focus", keys);
  } else go(startAt ? pathTo(startAt) : cmp >= 0 ? where() : [top]);
})();
