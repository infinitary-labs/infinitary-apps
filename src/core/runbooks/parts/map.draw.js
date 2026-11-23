  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  const scene = el("g", { class: "scene" }, svg);
  let V = null;
  let stack = [];
  let sel = null;
  const cam = { x: 0, y: 0, k: 1 };
  const W = () => svg.clientWidth || 700;
  const H = () => svg.clientHeight || 440;
  const apply = () =>
    svg.setAttribute("viewBox", `${cam.x} ${cam.y} ${W() / cam.k} ${H() / cam.k}`);
  const stOf = (n) =>
    n.kind === "state" ? n.st : n.ref && n.ref.kind === "grp" ? groupSt(n.ref) : n.ref && n.ref.st;
  // a machine nobody traced shows no tags, never "unchanged", nor does anything drawn in it, nor an
  // outside box on a map file this comparison cannot read
  const known = (n) =>
    n.kind === "mach"
      ? n.ref.known
      : V.ref.kind === "mach"
        ? V.ref.known
        : !(n.ref && n.ref.kind === "out" && !n.ref.lvl.wk);
  const stCls = (n) => {
    if (cmp < 0 || !known(n)) return "";
    const st = stOf(n);
    return st ? ` s${"+-~".indexOf(st)}` : " same";
  };
  const placeOf = (x) =>
    x.kind === "part"
      ? x.sub || x
      : x.kind === "out"
        ? byPath[x.path] && placeOf(byPath[x.path])
        : x;
  const opensPart = (P) => !P.gone && (P.sub || machsOf(P).length || (cmp >= 0 && P.fl.length));
  function opens(n) {
    if (n.kind === "state") return !!n.openable;
    if (n.kind === "file" || !n.ref) return false;
    if (n.kind === "grp" || n.kind === "mach") return true;
    const r = n.ref;
    if (r.kind === "grp") return true;
    if (r.kind === "out") return !!(byPath[r.path] && opensPart(byPath[r.path]));
    return r.kind === "part" && !!opensPart(r);
  }
  const same = (e) => Math.abs(e.a.x - e.b.x) < 1;
  const under = (n, s) =>
    V.nodes.some((m) => m !== n && Math.abs(m.x - n.x) < (m.w + n.w) / 2 && (m.y - n.y) * s > 0);
  const backY = (e) => {
    const { a, b } = e;
    const d = 26 + Math.abs(a.x - b.x) / 12;
    return e.up
      ? Math.min(a.y - a.h / 2, b.y - b.h / 2) - d
      : Math.max(a.y + a.h / 2, b.y + b.h / 2) + d;
  };
  function edgePath(e) {
    const a = e.a;
    const b = e.b;
    if (e.down) {
      const s = b.y > a.y ? 1 : -1;
      const y1 = a.y + (s * a.h) / 2;
      const y2 = b.y - (s * b.h) / 2;
      return `M${a.x} ${y1}C${a.x} ${(y1 + y2) / 2} ${b.x} ${(y1 + y2) / 2} ${b.x} ${y2}`;
    }
    if (same(e)) {
      const xr = Math.max(a.x + a.w / 2, b.x + b.w / 2);
      return `M${a.x + a.w / 2} ${a.y}C${xr + 46} ${a.y} ${xr + 46} ${b.y} ${b.x + b.w / 2} ${b.y}`;
    }
    if (e.back) {
      // a link going back loops under the boxes, or over them when a box sits right under an end
      const s = e.up ? -1 : 1;
      const yb = backY(e);
      return `M${a.x} ${a.y + (s * a.h) / 2}C${a.x} ${yb} ${b.x} ${yb} ${b.x} ${b.y + (s * b.h) / 2}`;
    }
    const x1 = a.x + a.w / 2;
    const x2 = b.x - b.w / 2;
    if (e.lane !== undefined) {
      // a link that would cross another box runs along a clear lane above or below the boxes
      const r = Math.min(40, (x2 - x1) / 4);
      return `M${x1} ${a.y}C${x1 + r} ${a.y} ${x1 + r} ${e.lane} ${x1 + 2 * r} ${e.lane}L${x2 - 2 * r} ${e.lane}C${x2 - r} ${e.lane} ${x2 - r} ${b.y} ${x2} ${b.y}`;
    }
    const m = Math.max(30, (x2 - x1) / 2);
    return `M${x1} ${a.y}C${x1 + m} ${a.y} ${x2 - m} ${b.y} ${x2} ${b.y}`;
  }
  // does the plain curve of a forward link pass through a box that is not its own end?
  function lanes() {
    for (const e of V.edges) {
      delete e.lane;
      if (e.back || e.down || e.a === e.b || same(e)) continue;
      const a = e.a;
      const b = e.b;
      const x1 = a.x + a.w / 2;
      const x2 = b.x - b.w / 2;
      if (x2 <= x1) continue;
      const m = Math.max(30, (x2 - x1) / 2);
      const pts = [];
      for (let i = 1; i < 12; i++) {
        const t = i / 12;
        const u = 1 - t;
        pts.push([
          u * u * u * x1 + 3 * u * u * t * (x1 + m) + 3 * u * t * t * (x2 - m) + t * t * t * x2,
          u * u * u * a.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t * t * t * b.y,
        ]);
      }
      const between = V.nodes.filter(
        (n) => n !== a && n !== b && n.x + n.w / 2 > x1 && n.x - n.w / 2 < x2,
      );
      const hit = between.some((n) =>
        pts.some(
          ([px, py]) => Math.abs(px - n.x) < n.w / 2 + 4 && Math.abs(py - n.y) < n.h / 2 + 4,
        ),
      );
      if (!hit) continue;
      const top = Math.min(...between.map((n) => n.y - n.h / 2)) - 14;
      const bot = Math.max(...between.map((n) => n.y + n.h / 2)) + 14;
      const mid = (a.y + b.y) / 2;
      e.lane = Math.abs(top - mid) <= Math.abs(bot - mid) ? top : bot;
    }
  }
  const edgeCls = (st, sameLink) =>
    st ? ` ${{ "+": "add", "-": "rem", "~": "chg" }[st]}` : sameLink ? " same" : "";
  function draw() {
    scene.textContent = "";
    const f = V.frame;
    if (f) {
      el("rect", { class: "frame", x: f.x, y: f.y, width: f.w, height: f.h, rx: 10 }, scene);
      el("text", { class: "flabel", x: f.x + 12, y: f.y + 20 }, scene).textContent = f.label;
      const fe = el("g", { class: "edges" }, scene);
      const link = (n, st, kept, out) => {
        const x1 = out ? f.x + f.w : n.x + n.w / 2;
        const x2 = out ? n.x - n.w / 2 : f.x;
        const y1 = out ? f.y + f.h / 2 : n.y;
        const y2 = out ? n.y : f.y + f.h / 2;
        const p = el(
          "path",
          {
            class: `e${edgeCls(st, kept)}`,
            d: `M${x1} ${y1}C${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}`,
            "stroke-width": 1.2,
            "marker-end": "url(#mza)",
          },
          fe,
        );
        p._n = n;
      };
      for (const [n, st, kept] of f.ins || []) link(n, st, kept, false);
      for (const [n, st, kept] of f.outs || []) link(n, st, kept, true);
    }
    // with many links, each box keeps only its strongest forward link until you click it
    const busy = V.edges.length > 2.5 * V.nodes.length;
    const bone = new Set();
    if (busy)
      for (const n of V.nodes) {
        const pick = (side) => {
          let best = null;
          for (const e of V.edges)
            if (e[side] === n && e.a !== e.b && !e.back && (!best || e.w > best.w)) best = e;
          return best;
        };
        const best = pick("a") || pick("b");
        if (best) bone.add(best);
      }
    // a link that came or went always shows
    for (const e of V.edges) if (e.mv || e.st === "+" || e.st === "-") bone.add(e);
    for (const e of V.edges) e.thin = busy && !bone.has(e);
    V.busy = busy;
    lanes();
    for (const e of V.edges)
      e.up = !!e.back && (under(e.a, 1) || under(e.b, 1)) && !under(e.a, -1) && !under(e.b, -1);
    const ge = el("g", { class: "edges" }, scene);
    for (const e of V.edges) {
      if (e.a === e.b) continue;
      e.el = el(
        "path",
        {
          class: `e${e.back ? " back" : ""}${e.thin ? " thin" : ""}${edgeCls(e.st, e.same)}`,
          d: edgePath(e),
          "stroke-width": 1 + Math.log10(1 + (e.w || 1)),
          "marker-end": "url(#mza)",
          "data-from": e.a.label,
          "data-to": e.b.label,
        },
        ge,
      );
    }
    const gl = el("g", { class: "elabels" }, scene);
    // labels never sit on a box or on another label that shows at the same time;
    // in a comparison a box's tag sits just above it and takes room too
    const taken = V.nodes.map((n) => [
      n.x - n.w / 2,
      n.y - n.h / 2 - (/ s\d/.test(stCls(n)) ? 18 : 0),
      n.x + n.w / 2,
      n.y + n.h / 2,
    ]);
    if (f) taken.push([f.x, f.y, f.x + f.label.length * 6.4 + 24, f.y + 28]);
    const hits = (r) =>
      taken.some((q) => r[0] < q[2] + 2 && r[2] > q[0] - 2 && r[1] < q[3] + 2 && r[3] > q[1] - 2);
    for (const e of [...V.edges].sort((p, q) => !!q.label - !!p.label)) {
      if (e.a === e.b || !e.label) continue;
      const t = e.label;
      const tw = t.length * 6 + 10;
      let mx = e.back ? (e.a.x + e.b.x) / 2 : (e.a.x + e.a.w / 2 + e.b.x - e.b.w / 2) / 2;
      let my = e.back ? backY(e) + (e.up ? 6 : -6) : (e.a.y + e.b.y) / 2;
      if (same(e)) {
        mx = Math.max(e.a.x + e.a.w / 2, e.b.x + e.b.w / 2) + 36 + tw / 2;
        my = (e.a.y + e.b.y) / 2;
      }
      if (e.lane !== undefined) my = e.lane;
      if (e.down) {
        mx = (e.a.x + e.b.x) / 2;
        my = (e.a.y + e.b.y) / 2;
      }
      let room = false;
      if (!e.thin) {
        // a label moves a little to find room; with none near its link it shows when you click an end
        for (const d of [0, 14, -14, 26, -26]) {
          if (!hits([mx - tw / 2, my + d - 8, mx + tw / 2, my + d + 8])) {
            my += d;
            room = true;
            break;
          }
        }
        if (room) taken.push([mx - tw / 2, my - 8, mx + tw / 2, my + 8]);
      }
      e.lx = [mx - tw / 2, my - 8, mx + tw / 2, my + 8];
      const g = el(
        "g",
        { class: `el${room ? " named" : ""}${e.st ? ` s${"+-~".indexOf(e.st)}` : ""}` },
        gl,
      );
      el("rect", { x: mx - tw / 2, y: my - 8, width: tw, height: 16, rx: 4 }, g);
      el("text", { x: mx, y: my + 4, "text-anchor": "middle" }, g).textContent = t;
      e.lab = g;
    }
    const gn = el("g", { class: "nodes" }, scene);
    for (const n of V.nodes) {
      const g = el(
        "g",
        {
          class: `n k-${n.kind}${opens(n) ? " open" : ""}${n.end ? " end" : ""}${n.first ? " first" : ""}${stCls(n)}`,
          transform: `translate(${n.x - n.w / 2} ${n.y - n.h / 2})`,
          "data-box": n.label,
        },
        gn,
      );
      // a box that holds a map of its own sits on a second box, like a stack
      if (n.kind === "grp" || (n.kind === "part" && n.ref.sub))
        el("rect", { class: "stack", x: 4, y: 4, width: n.w, height: n.h, rx: 7 }, g);
      el("rect", { width: n.w, height: n.h, rx: n.kind === "state" ? n.h / 2 : 7 }, g);
      if (n.end)
        el(
          "rect",
          { class: "in", x: 3, y: 3, width: n.w - 6, height: n.h - 6, rx: (n.h - 6) / 2 },
          g,
        );
      el(
        "text",
        {
          class: "lbl",
          x: n.w / 2,
          y: n.sub ? n.hb / 2 - 2 : n.hb / 2 + 4,
          "text-anchor": "middle",
        },
        g,
      ).textContent = n.label;
      if (n.sub)
        el(
          "text",
          { class: "sub", x: n.w / 2, y: n.hb / 2 + 13, "text-anchor": "middle" },
          g,
        ).textContent = n.sub;
      if (opens(n)) el("path", { class: "chev", d: `M${n.w - 13} ${n.hb / 2 - 4}l4 4l-4 4` }, g);
      n.mp.forEach((t, i) => {
        const w = pillW(t);
        const p = el(
          "g",
          {
            class: `mp${n.mm ? " go" : ""}${n.mc[i] ? ` s${"+-~".indexOf(n.mc[i])}` : ""}`,
            transform: `translate(${(n.w - w) / 2} ${n.hb - 4 + i * 19})`,
            "data-pill": t,
          },
          g,
        );
        el("rect", { width: w, height: 15, rx: 7.5 }, p);
        el("circle", { cx: 9, cy: 7.5, r: 2.5 }, p);
        el("text", { x: w / 2 + 4, y: 11, "text-anchor": "middle" }, p).textContent = t;
        if (n.mm) p._m = n.mm[i];
      });
      // a comparison names what happened to the box right above it
      const st = cmp >= 0 && / s\d/.test(stCls(n)) && stOf(n);
      if (st) {
        const t = DID["+-~".indexOf(st)];
        const tg = el("g", { class: "tag", transform: "translate(0 -16)" }, g);
        el("rect", { width: t.length * 6.2 + 12, height: 13, rx: 3 }, tg);
        el("text", { x: 6, y: 10 }, tg).textContent = t;
      }
      n.el = g;
      g._n = n;
    }
    mark();
  }
  // what is chosen: a box and its links, or one link the arrows stepped to and its two ends
  function mark() {
    if (sel) hot = null;
    const lit = new Set();
    const any = !!sel || !!hot;
    if (sel) {
      lit.add(sel);
      for (const e of V.edges) if (e.a === sel || e.b === sel) lit.add(e.a).add(e.b);
    }
    if (hot) lit.add(hot.a).add(hot.b);
    for (const n of V.nodes)
      n.el.classList.toggle(
        "dim",
        any && !lit.has(n) && !(sel && V.frame && n.inFrame && sel.kind === "ext"),
      );
    for (const n of V.nodes) n.el.classList.toggle("sel", n === sel);
    for (const e of V.edges) {
      if (!e.el) continue;
      const on = hot ? e === hot : sel && (e.a === sel || e.b === sel);
      e.el.classList.toggle("lit", !!on);
      e.el.classList.toggle("dim", any && !on);
      if (e.lab)
        e.lab.classList.toggle("show", !!on || (!any && e.lab.classList.contains("named")));
    }
    for (const p of scene.querySelectorAll(".edges path"))
      if (p._n) p.classList.toggle("lit", p._n === sel);
    const said = hot
      ? `${hot.a.label} → ${hot.b.label}${hot.label ? `: ${hot.label}` : ""} · ${DID["+-~".indexOf(hot.st)]}`
      : words(sel);
    liveEl.textContent = said;
    openBtn.hidden = !(sel && opens(sel));
    if (sel && (at < 0 || items[at].n !== sel)) at = items.findIndex((it) => it.n === sel && !it.e);
    if (!any) at = -1;
    counter();
    // the full-screen copy says where it stands, which the app hands back to the card's map on close
    if (full) window.inf?.expand?.(root, stateNow());
  }

  const files = (k) => `${fmt(k)} file${k === 1 ? "" : "s"}`;
  const sizeWords = (x) =>
    x && x.files !== undefined
      ? ` · ${files(x.files)}${x.lines !== undefined ? ` · ${fmt(x.lines)} lines` : ""}`
      : "";
  const chWords = (c) =>
    cmp >= 0 && c && c[0] + c[1] + c[2]
      ? ` · ${files(c[0])} added, ${fmt(c[1])} removed, ${fmt(c[2])} changed`
      : "";
  const machWords = (m) => {
    if (cmp < 0 || !m.known || !m.cs) return "";
    const part = (c, one, many) =>
      DID.map((w, j) => c[j] && `${fmt(c[j])} ${c[j] === 1 ? one : many} ${w}`).filter(Boolean);
    const all = [...part(m.cs[0], "state", "states"), ...part(m.cs[1], "move", "moves")];
    return ` · ${all.length ? all.join(", ") : "unchanged"}`;
  };
  function words(n) {
    const busy = V.busy ? " · strongest links shown, click a box for all of them" : "";
    // the place's own words: the trail names it and the counts at the end of the row say what changed
    if (!n) {
      const r = V.ref;
      if (r.kind === "mach") {
        const by = [...new Set(r.tr.map((t) => t[3]).filter(Boolean))];
        return `${r.states.length} states, ${r.tr.length} moves${r.about ? ` · ${r.about}` : ""}${by.length ? ` · moved by ${by.join(", ")}` : ""}`;
      }
      if (r.kind === "grp") {
        const ks = kidsOfGroup(r);
        return `${r.why ? `${r.why} · ` : ""}${ks.length === 1 ? "1 part" : `${ks.length} parts`}${sizeWords(total(ks))}${busy}`;
      }
      if (r.kind === "part") return `${r.path}${r.about ? `: ${r.about}` : ""}${sizeWords(r)}`;
      const ps = r.parts;
      return `${ps.length === 1 ? "1 part" : `${ps.length} parts`}${r.groups.length ? ` in ${r.groups.length} groups` : ""}${sizeWords(r.part || total(ps))}${busy}`;
    }
    const uses = V.edges.filter((e) => e.a === n && e.b !== n);
    const used = V.edges.filter((e) => e.b === n && e.a !== n);
    const r = n.ref;
    let t = n.label;
    if (n.kind === "file" && r)
      t += `: ${r.st === "~" ? `${fmt(r.add)} lines added and ${fmt(r.del)} removed` : r.st === "+" ? `added, ${fmt(r.add)} lines` : `removed, ${fmt(r.del)} lines`}`;
    else if (n.kind === "file") t += ": not changed";
    else if (n.kind === "state")
      t += `: ${uses.length === 1 ? "1 way out" : `${uses.length} ways out`}, ${used.length === 1 ? "1 way in" : `${used.length} ways in`}`;
    else if (n.kind === "mach") t += `: ${r.states.join(", ")}${machWords(r)}`;
    else if (r && r.kind === "grp")
      t += `: ${r.why ? `${r.why} · ` : ""}${kidsOfGroup(r)
        .map((P) => P.name)
        .join(", ")}${chWords(groupCh(r))}`;
    else if (r && (r.kind === "part" || r.kind === "out"))
      t += `${r.about ? `: ${r.about}` : ""}${r.kind === "part" ? `${sizeWords(r)}${r.gone ? " · removed" : chWords(r.ch)}` : r.st === "+" ? " · added" : r.st === "-" ? " · removed" : ""}`;
    if (n.mach && n.mach.length) t += ` · holds ${n.mach.map((m) => m.name).join(", ")}`;
    for (const e of V.edges)
      if (e.mv && (e.a === n || e.b === n))
        for (const [m, ix] of e.mv)
          t += ` · ${e.a.label} moves ${m.name}: ${ix.map((i) => m.tr[i][2]).join(", ")}`;
    if (n.kind !== "state" && n.kind !== "file") {
      const whys = [
        ...uses.map((e) => e.n === 1 && e.why && `uses ${e.b.label} for ${e.why}`),
        ...used.map((e) => e.n === 1 && e.why && `${e.a.label} uses it for ${e.why}`),
      ].filter(Boolean);
      if (uses.length || used.length)
        t += ` · uses ${uses.length}, used by ${used.length} here${whys.length ? ` (${whys.slice(0, 4).join("; ")})` : ""}`;
    }
    if (opens(n)) t += " · Enter to go in";
    return t;
  }
  const nameOf = (r) => (r.kind === "lvl" ? (r.part ? r.part.name : r.name) : r.name);
  // the trail of places, on one line: it folds from the left, and Up still climbs past the fold
  // the trail is one line that loses its start first: the place itself stays in view
  function crumbs() {
    crumbEl.textContent = "";
    const line = mk("span", "", crumbEl);
    stack.forEach((r, i) => {
      if (i) line.append(" › ");
      const b = mk("button", nameOf(r), line);
      if (i === stack.length - 1) b.setAttribute("aria-current", "true");
      b.onclick = () => go(stack.slice(0, i + 1));
    });
  }
  const mk = (tag, text, parent) => {
    const x = document.createElement(tag);
    if (text) x.textContent = text;
    parent.append(x);
    return x;
  };
  // what this level added, removed and changed, in that order: the arrows step through it, More lists it all
  let items = [];
  let at = -1;
  let hot = null;
  function list() {
    chgEl.textContent = "";
    chgEl.hidden = cmp < 0;
    items = [];
    at = -1;
    hot = null;
    if (cmp < 0) return;
    const t = [0, 0, 0];
    let la = 0;
    let ld = 0;
    for (const [, st, add, del] of CMP[cmp].files || []) {
      if (!"+-~".includes(st)) continue;
      t["+-~".indexOf(st)]++;
      la += add || 0;
      ld += del || 0;
    }
    mk(
      "p",
      `${CMP[cmp].label}: ${files(t[0])} added, ${fmt(t[1])} removed, ${fmt(t[2])} changed · ${fmt(la)} lines added, ${fmt(ld)} removed`,
      chgEl,
    );
    const cols = mk("div", "", chgEl);
    const f = V.frame;
    const here = f && V.ref.kind === "part" ? V.ref.name : "";
    const ln = [
      ...V.edges.filter((e) => e.st && !e.mv),
      ...(here
        ? [
            ...f.ins.map(([n, st]) => ({ a: n, b: { label: here }, st })),
            ...f.outs.map(([n, st]) => ({ a: { label: here }, b: n, st })),
          ]
        : []),
    ];
    // a machine's lists name its states, never the boxes that make its moves
    const listed = (n) => V.ref.kind !== "mach" || n.kind === "state";
    ["Added", "Removed", "Changed"].forEach((name, i) => {
      const L = V.nodes
        .filter((n) => listed(n) && / s\d/.test(stCls(n)) && stOf(n) === "+-~"[i])
        .map((n) => ({ label: n.label, n, s: i }));
      const K = ln
        .filter((e) => e.st === "+-~"[i])
        .map((e) => ({
          label: `${e.a.label} → ${e.b.label}`,
          n: e.a.x === undefined ? e.b : e.a,
          e: e.el ? e : null,
          s: i,
        }));
      const c = mk("div", "", cols);
      c.className = `s${i}`;
      const [b1, bn, l1, lnn] =
        V.ref.kind === "mach"
          ? ["state", "states", "move", "moves"]
          : ["box", "boxes", "link", "links"];
      mk(
        "h4",
        `${name} here: ${L.length || K.length ? [L.length && `${fmt(L.length)} ${L.length === 1 ? b1 : bn}`, K.length && `${fmt(K.length)} ${K.length === 1 ? l1 : lnn}`].filter(Boolean).join(", ") : "none"}`,
        c,
      );
      for (const it of [...L, ...K]) {
        const k = items.push(it) - 1;
        const b = mk("button", it.label, c);
        b.onclick = () => stepTo(k);
      }
    });
  }
  // the counts of this level's changes, or where the arrows stand among them
  function counter() {
    stepEl.hidden = cmp < 0;
    if (cmp < 0) return;
    posEl.textContent = "";
    if (at >= 0 || !items.length) {
      posEl.textContent = items.length ? `${at + 1} of ${items.length}` : "no changes here";
      return;
    }
    const c = [0, 0, 0];
    for (const it of items) c[it.s]++;
    c.forEach((x, i) => {
      if (!x) return;
      if (posEl.childNodes.length) posEl.append(" · ");
      mk("b", `${fmt(x)} ${DID[i]}`, posEl).className = `s${i}`;
    });
  }
  function stepTo(k) {
    if (!items.length) return;
    at = (k + items.length) % items.length;
    const it = items[at];
    hot = it.e;
    sel = hot ? null : it.n;
    mark();
    reveal(hot ? hot.el : sel && sel.el);
  }
