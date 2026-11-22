  // ---- layout: users on the left, what they use on the right
  const CH = 7.2;
  const pillW = (t) => t.length * 6.2 + 26;
  function sizeBoxes(V) {
    const maxP = Math.max(1, ...V.nodes.map((n) => n.pull));
    for (const n of V.nodes) {
      const g = Math.sqrt(n.pull / maxP);
      const chars = Math.max(n.label.length * 1.08, (n.sub || "").length * 0.86);
      // the state machines a box holds sit inside it, one pill each, and a pill opens its machine
      const ms = n.mach || [];
      const mc = cmp < 0 ? 0 : ms.filter((m) => m.st).length;
      n.mp =
        ms.length > 3
          ? [`${ms.length} state machines${mc ? `, ${mc} changed` : ""}`]
          : ms.map((m) => m.name);
      n.mc =
        n.mp.length === ms.length ? ms.map((m) => (cmp >= 0 && m.st) || "") : [mc > 0 ? "~" : ""];
      n.mm = n.mp.length === ms.length ? ms : null;
      const pw = Math.max(0, ...n.mp.map(pillW));
      n.w = Math.round(Math.max(84 + 56 * g, chars * CH + 26, pw + 16));
      n.hb = Math.round(40 + 16 * g + (n.sub ? 8 : 0));
      n.h = n.hb + (n.mp.length ? n.mp.length * 19 + 4 : 0);
    }
  }
  function layered(nodes, edges, sides = 0) {
    // break loops the greedy way (Eades), then each box sits one column after its furthest user
    const idx = new Map(nodes.map((n, i) => [n, i]));
    const out = nodes.map(() => []);
    const inn = nodes.map(() => []);
    for (const e of edges) {
      if (e.a === e.b) continue;
      out[idx.get(e.a)].push(e);
      inn[idx.get(e.b)].push(e);
    }
    const left = new Set(nodes.keys());
    const s1 = [];
    const s2 = [];
    nodes.forEach((n, i) => {
      if (n.first) {
        s1.push(i);
        left.delete(i);
      }
    });
    const deg = (i, L) =>
      L[i].reduce(
        (s, e) => s + (left.has(idx.get(L === out ? e.b : e.a)) ? 1 + Math.log1p(e.w) : 0),
        0,
      );
    while (left.size) {
      let moved = true;
      while (moved) {
        moved = false;
        for (const i of [...left]) {
          if (!deg(i, out)) {
            s2.unshift(i);
            left.delete(i);
            moved = true;
          } else if (!deg(i, inn)) {
            s1.push(i);
            left.delete(i);
            moved = true;
          }
        }
      }
      if (!left.size) break;
      let best = -1;
      let bv = -Infinity;
      for (const i of left) {
        const v = deg(i, out) - deg(i, inn) - nodes[i].pull * 1e-6;
        if (v > bv) {
          bv = v;
          best = i;
        }
      }
      s1.push(best);
      left.delete(best);
    }
    const order = new Map([...s1, ...s2].map((i, k) => [i, k]));
    const col = nodes.map(() => 0);
    for (const i of [...s1, ...s2])
      for (const e of out[i]) {
        const j = idx.get(e.b);
        e.back = order.get(j) < order.get(i);
        if (!e.back) col[j] = Math.max(col[j], col[i] + 1);
      }
    // pull each box right against what it uses, so a column never strands far from its links
    for (let i = 0; i < nodes.length; i++) {
      const ts = out[i].filter((e) => !e.back).map((e) => col[idx.get(e.b)] - 1);
      if (ts.length && !inn[i].some((e) => !e.back)) col[i] = Math.min(...ts);
    }
    // a long chain folds into a few columns that fit the card, keeping its order
    const CAP = Math.max(2, Math.min(6, Math.round(Math.sqrt(nodes.length * 1.6))) - sides);
    if (Math.max(...col) + 1 > CAP) {
      const ord = nodes
        .map((n, i) => i)
        .sort((i, j) => col[i] - col[j] || order.get(i) - order.get(j));
      ord.forEach((i, r) => {
        col[i] = Math.floor((r * CAP) / nodes.length);
      });
    }
    const cols = [];
    for (const [i, n] of nodes.entries()) {
      cols[col[i]] = cols[col[i]] || [];
      cols[col[i]].push(n);
    }
    const flat = [];
    for (const c of cols.filter(Boolean)) {
      if (c.length > 9) {
        const half = Math.ceil(c.length / 2);
        flat.push(c.slice(0, half), c.slice(half));
      } else flat.push(c);
    }
    flat.forEach((c, k) => {
      for (const n of c) n.c = k;
    });
    const nb = (n) =>
      edges
        .filter((e) => (e.a === n || e.b === n) && e.a !== e.b)
        .map((e) => (e.a === n ? e.b : e.a));
    for (let pass = 0; pass < 8; pass++)
      for (const c of pass % 2 ? [...flat].reverse() : flat) {
        for (const n of c) {
          const ys = nb(n).filter((m) => m.c !== n.c && m.y !== undefined);
          n.bary = ys.length ? ys.reduce((s, m) => s + m.y, 0) / ys.length : (n.y ?? 0);
        }
        c.sort((a, b) => a.bary - b.bary || b.pull - a.pull);
        let y = 0;
        for (const n of c) {
          n.y = y + n.h / 2;
          y += n.h + 22;
        }
        for (const n of c) n.y -= y / 2;
      }
    // a gap is wide enough for the longest label that crosses it
    let x = 0;
    flat.forEach((c, k) => {
      const w = Math.max(...c.map((n) => n.w));
      for (const n of c) n.x = x + w / 2;
      const cross = edges
        .filter((e) => !e.back && e.a.c === k && e.b.c === k + 1 && e.label)
        .map((e) => e.label.length * 6 + 10);
      x += w + Math.max(64, 36 + Math.max(0, ...cross));
    });
  }
  // a level or a group sits in its own dashed frame; what uses it waits on the left, what it uses on the right
  function framed(V) {
    const inner = V.nodes.filter((n) => n.kind !== "ext");
    const outer = V.nodes.filter((n) => n.kind === "ext");
    const mine = new Set(inner);
    const r = V.ref;
    const sides =
      r === top || r.kind === "mach"
        ? 0
        : new Set(outer.map((n) => (V.edges.some((e) => e.a === n) ? "L" : "R"))).size;
    const cells = r.kind === "lvl" && r.place;
    if (cells) placeCells(inner, V.edges, cells);
    else
      layered(
        inner,
        V.edges.filter((e) => mine.has(e.a) && mine.has(e.b)),
        sides,
      );
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of inner) {
      x0 = Math.min(x0, n.x - n.w / 2);
      y0 = Math.min(y0, n.y - n.h / 2);
      x1 = Math.max(x1, n.x + n.w / 2);
      y1 = Math.max(y1, n.y + n.h / 2);
    }
    if (!inner.length) [x0, y0, x1, y1] = [0, 0, 160, 40];
    const label =
      r.kind === "grp"
        ? `${nameOf(r.lvl)} › ${r.name}`
        : r.kind === "mach"
          ? `${r.holder ? r.holder.path : ""} › ${r.name}`
          : nameOf(r);
    V.frame = {
      label,
      x: x0 - 22,
      y: y0 - 44,
      w: x1 - x0 + 44,
      h: y1 - y0 + 66,
      ins: [],
      outs: [],
      more: [0, 0],
    };
    const f = V.frame;
    const L = [];
    const R = [];
    for (const n of outer) {
      let i = 0;
      let o = 0;
      let ys = 0;
      let c = 0;
      for (const e of V.edges) {
        if (e.a === n && mine.has(e.b)) (i += e.w || 1), (ys += e.b.y), c++;
        if (e.b === n && mine.has(e.a)) (o += e.w || 1), (ys += e.a.y), c++;
      }
      n.bary = c ? ys / c : 0;
      (i >= o ? L : R).push(n);
    }
    const column = (list, x, right) => {
      list.sort((a, b) => a.bary - b.bary || b.pull - a.pull);
      // in a comparison each box's tag sits just above it, so the column leaves room for it
      const gap = cmp < 0 ? 16 : 24;
      const tall = list.reduce((s, n) => s + n.h + gap, -gap);
      let y = f.y + f.h / 2 - tall / 2;
      for (const n of list) {
        n.x = right ? x + n.w / 2 : x - n.w / 2;
        n.y = y + n.h / 2;
        y += n.h + gap;
      }
    };
    // a link label from outside needs room between the column and the frame
    const lw = (side) =>
      Math.max(
        48,
        ...V.edges
          .filter(
            (e) =>
              e.label &&
              side.includes(e.a) !== side.includes(e.b) &&
              !(mine.has(e.a) && mine.has(e.b)),
          )
          .map((e) => e.label.length * 6 - 8),
      );
    column(L, f.x - lw(L), false);
    column(R, f.x + f.w + lw(R), true);
    for (const e of V.edges) if (!mine.has(e.a) || !mine.has(e.b)) e.back = e.a.x > e.b.x;
  }
  // a map file that says where its boxes go is drawn that way, column by column and row by row
  function placeCells(nodes, edges, cells) {
    const cw = [];
    const rh = [];
    let spare = 0;
    const ok = (c) =>
      Array.isArray(c) &&
      Number.isInteger(c[0]) &&
      Number.isInteger(c[1]) &&
      c[0] >= 0 &&
      c[1] >= 0;
    const rows = Math.max(
      0,
      ...Object.values(cells)
        .filter(ok)
        .map((c) => c[1] + 1),
    );
    const taken = new Set();
    for (const n of nodes) {
      const want = cells[n.label];
      const free = ok(want) && !taken.has(`${want}`);
      const [c, r] = free ? want : [0, rows + spare++];
      taken.add(`${[c, r]}`);
      n.c = c;
      n.r = r;
      cw[c] = Math.max(cw[c] || 0, n.w);
      rh[r] = Math.max(rh[r] || 0, n.h);
    }
    const cx = [];
    const ry = [];
    let x = 0;
    for (let i = 0; i < cw.length; i++) {
      cx[i] = x + (cw[i] || 0) / 2;
      const lw = edges
        .filter((e) => e.label && e.a.c === i && e.b.c === i + 1 && e.a.r === e.b.r)
        .map((e) => e.label.length * 6 + 10);
      x += (cw[i] || 0) + Math.max(64, 36 + Math.max(0, ...lw));
    }
    let y = 0;
    for (let i = 0; i < rh.length; i++) {
      ry[i] = y + (rh[i] || 0) / 2;
      y += (rh[i] || 0) + (rh[i] ? 44 : 0);
    }
    for (const n of nodes) {
      n.x = cx[n.c];
      n.y = ry[n.r];
    }
    const mine = new Set(nodes);
    for (const e of edges) {
      if (!mine.has(e.a) || !mine.has(e.b)) continue;
      e.back = false;
      // straight down when nothing sits between; around the side when a box is in the way
      const blocked =
        e.a.c === e.b.c && nodes.some((n) => n.c === e.a.c && (n.r - e.a.r) * (n.r - e.b.r) < 0);
      e.down = !blocked && e.a.r !== e.b.r && (e.a.c === e.b.c || e.b.x < e.a.x);
    }
  }
  function grid(V) {
    const F = V.nodes.filter((n) => n.inFrame || n.kind === "mach");
    const cw = Math.max(120, ...F.map((n) => n.w)) + 14;
    const rowH = Math.max(40, ...F.map((n) => n.h)) + 20;
    const sideW = 2 * (Math.max(0, ...[...V.frame.ins, ...V.frame.outs].map(([n]) => n.w)) + 56);
    // as many columns as make the whole part largest in the card
    let k = 1;
    let best = 0;
    for (let c = 1; c <= Math.max(1, F.length); c++) {
      const sc = Math.min(W() / (c * cw + 32 + sideW), H() / (Math.ceil(F.length / c) * rowH + 70));
      if (sc > best) {
        best = sc;
        k = c;
      }
    }
    let y = 0;
    for (let r = 0; r * k < F.length; r++) {
      const row = F.slice(r * k, r * k + k);
      const rh = Math.max(...row.map((n) => n.h));
      row.forEach((n, i) => {
        n.x = i * cw + cw / 2;
        n.y = y + rh / 2;
      });
      y += rh + 20;
    }
    const f = V.frame;
    Object.assign(f, {
      x: -16,
      y: -44,
      w: Math.max(1, Math.min(F.length, k)) * cw + 32,
      h: Math.max(y, 40) + 46,
    });
    const gap = cmp < 0 ? 10 : 24;
    const stack = (L, x) => {
      let yy = f.y + f.h / 2 - L.reduce((s, [n]) => s + n.h + gap, -gap) / 2;
      for (const [n] of L) {
        n.x = x;
        n.y = yy + n.h / 2;
        yy += n.h + gap;
      }
    };
    stack(f.ins, f.x - 56 - Math.max(0, ...f.ins.map(([n]) => n.w / 2)));
    stack(f.outs, f.x + f.w + 56 + Math.max(0, ...f.outs.map(([n]) => n.w / 2)));
  }

