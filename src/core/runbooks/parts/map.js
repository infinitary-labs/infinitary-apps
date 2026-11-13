(async () => {
  const root = document.getElementById("map");
  const $ = (q) => root.querySelector(q);
  const svg = $("svg");
  svg.tabIndex = 0; // the map takes the keyboard: arrows choose, Enter goes in, Esc goes back
  const liveEl = $("[data-live]");
  const crumbEl = $("[data-crumbs]");
  const chgEl = $("[data-chg]");
  const badEl = $("[data-bad]");
  const moreEl = $("[data-morebox]");
  const moreBtn = $("[data-more]");
  const stepEl = $("[data-step]");
  const posEl = $("[data-pos]");
  const openBtn = $("[data-open]");
  // a touch screen draws the diagram as a fitted picture: one finger scrolls the card past it, a tap opens it
  const touch = matchMedia("(hover: none) and (pointer: coarse)").matches;
  root.classList.toggle("touch", touch);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const NS = "http://www.w3.org/2000/svg";
  const fmt = (x) => x.toLocaleString("en-US");
  const DID = ["added", "removed", "changed"];
  const bad = [];
  const problem = (t) => bad.push(t);
  let D = {};
  try {
    const block = $("script[data-map]");
    const src = block.getAttribute("src");
    let text = block.textContent;
    if (src) {
      // a card names its data in a file, as it names a picture: the card's bridge hands the app's copy over
      if (!window.inf?.data) throw new Error("only a card can read its data file");
      text = await window.inf.data(src);
    } else if (block.hasAttribute("data-packed")) {
      const bin = Uint8Array.from(atob(text.trim()), (c) => c.charCodeAt(0));
      text = await new Response(
        new Blob([bin]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
      ).text();
    }
    D = JSON.parse(text);
  } catch (e) {
    problem(`The map data could not be read: ${e.message}`);
  }
  const maps = D.maps || {};
  const counts = D.counts || {};
  const CMP = D.compare || [];

  // ---- the model: levels from map files, their parts, groups, outside boxes, links and machines
  const parts = [];
  const machs = [];
  const byPath = {};
  const machByName = {};
  const inside = (path, folder) => !folder || path === folder || path.startsWith(`${folder}/`);
  // a map file's names, its parts and outside boxes, read the same way for today and for a comparison
  function readFile(L, file, gone) {
    const names = {};
    const groups = {};
    for (const g of L.groups) groups[g.name] = g;
    const name = (x, kind) => {
      if (!x || typeof x.name !== "string" || !x.name)
        return problem(`A ${kind} in ${L.where} has no name.`);
      if (names[x.name] && !gone) problem(`${L.where} names ${x.name} twice.`);
      return x.name;
    };
    const ps = [];
    for (const p of file.parts || []) {
      if (!name(p, "part")) continue;
      if (typeof p.path !== "string" || !inside(p.path, L.folder) || p.path === L.folder)
        problem(`${p.name} in ${L.where} needs a folder inside ${L.folder || "the project"}.`);
      const P = {
        kind: "part",
        name: p.name,
        about: p.about || "",
        path: p.path || "",
        lvl: L,
        g: null,
        sub: null,
        mach: [],
        gone,
      };
      if (p.group) {
        P.g = groups[p.group] || null;
        if (!P.g && !gone)
          problem(`${p.name} in ${L.where} names a group, ${p.group}, the file does not list.`);
      }
      names[P.name] = P;
      ps.push(P);
    }
    const os = [];
    for (const o of file.outside || []) {
      if (!name(o, "outside box")) continue;
      const O = { kind: "out", name: o.name, about: o.about || "", path: o.path || "", lvl: L };
      names[O.name] = O;
      os.push(O);
    }
    const ls = [];
    for (const l of file.links || []) {
      const a = names[l.from];
      const b = names[l.to];
      if (!a || !b) {
        if (!gone)
          problem(
            `A link in ${L.where} names ${a ? l.to : l.from}, which is not a part or outside box there.`,
          );
        continue;
      }
      ls.push({ a, b, why: l.why || "" });
    }
    return { names, ps, os, ls };
  }
  function readMachine(m, L, names, gone) {
    const states = Array.isArray(m.states) ? m.states : [];
    const M = {
      kind: "mach",
      name: m.name,
      about: m.about || "",
      states,
      opens: m.opens || {},
      lvl: L,
      holder: names[m.in],
      tr: [],
    };
    if (!gone && (!M.holder || M.holder.kind !== "part"))
      problem(`The machine ${m.name} in ${L.where} needs "in" to name one of its parts.`);
    for (const v of m.moves || []) {
      if (!states.includes(v.from) || !states.includes(v.to)) {
        if (!gone)
          problem(
            `A move of ${m.name} goes from ${v.from} to ${v.to}, and both must be its states.`,
          );
        continue;
      }
      if (v.by && !names[v.by] && !gone)
        problem(
          `A move of ${m.name} names ${v.by} as its maker, which is not a part or outside box in ${L.where}.`,
        );
      M.tr.push([v.from, v.to, v.why || "", v.by || ""]);
    }
    return M;
  }
  function level(folder, file, part, seen) {
    const L = {
      kind: "lvl",
      folder,
      file,
      part,
      name: part ? part.name : file.name || "Map",
      about: file.about || part?.about || "",
      place: file.place || null,
      where: folder ? `${folder}/.architecture.json` : ".architecture.json",
    };
    L.groups = (file.groups || [])
      .filter((g) => g && g.name)
      .map((g) => ({ kind: "grp", name: g.name, why: g.why || "", lvl: L }));
    const { names, ps, os, ls } = readFile(L, file, false);
    const cells = {};
    for (const [box, cell] of Object.entries(L.place || {})) {
      if (cells[cell]) problem(`${L.where} places ${box} and ${cells[cell]} in one spot.`);
      cells[cell] = box;
    }
    Object.assign(L, { names, parts: ps, outs: os, links: ls, machs: [] });
    for (const m of file.machines || []) {
      if (!m || !m.name) continue;
      const M = readMachine(m, L, names, false);
      if (machByName[M.name]) problem(`Two machines are named ${M.name}.`);
      machByName[M.name] = M;
      L.machs.push(M);
      machs.push(M);
      if (M.holder && M.holder.kind === "part") M.holder.mach.push(M);
    }
    for (const P of ps) {
      parts.push(P);
      byPath[P.path] = P;
      if (maps[P.path] && !seen.has(P.path))
        P.sub = level(P.path, maps[P.path], P, new Set([...seen, P.path]));
    }
    return L;
  }
  const rootKey = "" in maps ? "" : Object.keys(maps).sort((a, b) => a.length - b.length)[0];
  if (rootKey === undefined) problem("No map files were given.");
  const top = level(
    rootKey || "",
    maps[rootKey] || { name: "Map", parts: [] },
    null,
    new Set([rootKey]),
  );
  for (const k of Object.keys(maps))
    if (k !== rootKey && !byPath[k])
      problem(`The map file in ${k} is not a part's folder on the map above it.`);
  for (const M of machs)
    for (const s of Object.values(M.opens))
      if (!machByName[s]) problem(`${M.name} opens ${s}, which is not a machine on the map.`);
  // sizes come from the counts given; a part with its own map adds up its parts
  const kidsOf = (P) => (P.sub ? P.sub.parts : []);
  function size(P) {
    const c = counts[P.path];
    const ks = kidsOf(P).map(size).filter(Boolean);
    P.files = c ? c.files : ks.length ? ks.reduce((s, k) => s + k.files, 0) : undefined;
    P.lines = c ? c.lines : ks.length ? ks.reduce((s, k) => s + k.lines, 0) : undefined;
    return P.files === undefined ? null : P;
  }
  for (const P of top.parts) size(P);
  const total = (ps) => {
    const known = ps.filter((P) => P.files !== undefined);
    return known.length
      ? {
          files: known.reduce((s, P) => s + P.files, 0),
          lines: known.reduce((s, P) => s + (P.lines || 0), 0),
        }
      : null;
  };
  // the machines a part holds, and in a comparison those its map file held before and no longer does
  const machsOf = (P) => (cmp < 0 || !P.gm ? P.mach : [...P.mach, ...P.gm]);
  const allMachs = (P) => [...machsOf(P), ...kidsOf(P).flatMap(allMachs)];
  const kidsOfGroup = (G) => partsOf(G.lvl).filter((P) => P.g === G);

  // ---- a comparison: files from git, links and machines from both versions of the map files
  let cmp = -1;
  const deepest = (path) => {
    let best = null;
    for (const P of parts)
      if (path.startsWith(`${P.path}/`) && (!best || P.path.length > best.path.length)) best = P;
    return best;
  };
  const up = (P) => (P.lvl.part ? [P, ...up(P.lvl.part)] : [P]);
  // a name on a level: a part or outside box today, or one this comparison found removed
  const named = (L, name) =>
    L.names[name] ||
    (L.gp || []).find((P) => P.name === name) ||
    (L.go || []).find((O) => O.name === name);
  function compare(i) {
    cmp = i;
    const C = CMP[i] || {};
    const levels = [];
    const walk = (L) => {
      levels.push(L);
      for (const P of L.parts) if (P.sub) walk(P.sub);
    };
    walk(top);
    for (const P of parts) Object.assign(P, { st: "", ch: [0, 0, 0], fl: [], gm: [] });
    // every link and outside box starts untagged: a level this comparison cannot read keeps no earlier comparison's tags
    for (const L of levels) {
      Object.assign(L, { gp: [], go: [], gl: [], gm: [], wk: undefined });
      for (const O of L.outs) O.st = "";
      for (const l of L.links) {
        delete l.st;
        delete l.old;
      }
    }
    if (i < 0) {
      for (const M of machs)
        Object.assign(M, {
          st: "",
          known: false,
          sst: {},
          tst: [],
          goneSt: [],
          goneTr: [],
          o: (s) => s,
        });
      return;
    }
    const was = C.was || {};
    const untraced = new Set(C.untraced || []);
    for (const L of levels) {
      // a folder missing from "was" had the same map file; null means it had none to compare
      const wk = L.folder in was ? was[L.folder] : L.file;
      L.wk = wk;
      if (!wk) continue;
      const old = readFile(L, wk, true);
      for (const P of old.ps)
        if (!L.names[P.name] || L.names[P.name].kind !== "part") {
          Object.assign(P, { st: "-", ch: [0, 0, 0], fl: [], gm: [] });
          if (P.g) P.g = L.groups.find((g) => g.name === P.g.name) || null;
          L.gp.push(P);
        }
      for (const P of L.parts) if (!old.names[P.name]) P.st = "+";
      for (const O of old.os)
        if (!L.names[O.name] || L.names[O.name].kind !== "out")
          L.go.push(Object.assign(O, { st: "-", gone: true }));
      for (const O of L.outs) if (!old.names[O.name]) O.st = "+";
      const find = (x) => named(L, x.name);
      for (const l of L.links) {
        const o = old.ls.find((k) => k.a.name === l.a.name && k.b.name === l.b.name);
        l.st = !o ? "+" : o.why !== l.why ? "~" : "=";
        l.old = o && o.why;
      }
      for (const k of old.ls) {
        if (L.links.some((l) => l.a.name === k.a.name && l.b.name === k.b.name)) continue;
        const a = find(k.a);
        const b = find(k.b);
        if (a && b) L.gl.push({ a, b, why: k.why, st: "-" });
      }
      // a machine the map file no longer holds shows removed, every state and move, in the part that held it
      for (const om of wk.machines || []) {
        if (!om || !om.name || untraced.has(om.name) || L.machs.some((M) => M.name === om.name))
          continue;
        const G = readMachine(om, L, old.names, true);
        const H = G.holder && find(G.holder);
        if (!H || H.kind !== "part") continue;
        Object.assign(G, {
          holder: H,
          gone: true,
          st: "-",
          known: true,
          opens: {},
          sst: Object.fromEntries(G.states.map((x) => [x, "-"])),
          tst: G.tr.map(() => ["-"]),
          goneSt: [],
          goneTr: [],
          o: (x) => x,
          cs: [
            [0, G.states.length, 0],
            [0, G.tr.length, 0],
          ],
        });
        G.ch = [0, G.states.length + G.tr.length, 0];
        H.gm.push(G);
        L.gm.push(G);
      }
    }
    // each changed file counts in the deepest part that holds it and in every part around that
    for (const [path, st, add, del] of C.files || []) {
      let P = deepest(path);
      for (const G of levels.flatMap((L) => L.gp))
        if (path.startsWith(`${G.path}/`) && (!P || G.path.length > P.path.length)) P = G;
      if (!P || !"+-~".includes(st)) continue;
      P.fl.push({
        kind: "file",
        name: path.slice(P.path.length + 1),
        st,
        add: add || 0,
        del: del || 0,
      });
      for (const Q of P.gone ? [P, ...(P.lvl.part ? up(P.lvl.part) : [])] : up(P))
        Q.ch["+-~".indexOf(st)]++;
    }
    for (const P of parts)
      if (!P.st && P.ch.some(Boolean)) P.st = P.files && P.ch[0] === P.files ? "+" : "~";
    // a machine compares with the one of its name in the other map file; one nobody traced shows no tags
    for (const M of machs) {
      const wk = M.lvl.wk;
      const known = !!wk && !untraced.has(M.name);
      Object.assign(M, {
        st: "",
        known,
        sst: {},
        tst: M.tr.map(() => [""]),
        goneSt: [],
        goneTr: [],
        o: (s) => s,
      });
      if (!known) continue;
      const om = (wk.machines || []).find((m) => m && m.name === M.name);
      const w = om
        ? readMachine(om, M.lvl, readFile(M.lvl, wk, true).names, true)
        : { states: [], tr: [] };
      const names = (C.names || {})[M.name] || {};
      M.o = (s) => names[s] || s;
      const o = M.o;
      for (const x of M.states) M.sst[x] = !w.states.includes(o(x)) ? "+" : o(x) !== x ? "~" : "";
      M.goneSt = w.states.filter((x) => !M.states.some((y) => o(y) === x));
      M.tst = M.tr.map(([a, b, why]) => {
        const old = w.tr.find((t) => t[0] === o(a) && t[1] === o(b));
        return !old ? ["+"] : old[2] !== why ? ["~", old[2]] : [""];
      });
      M.goneTr = w.tr.filter((t) => !M.tr.some(([a, b]) => o(a) === t[0] && o(b) === t[1]));
      const cnt = (xs, gone) =>
        [0, gone, 0].map((g, j) => g + xs.filter((x) => x === "+-~"[j]).length);
      M.cs = [
        cnt(Object.values(M.sst), M.goneSt.length),
        cnt(
          M.tst.map((t) => t[0]),
          M.goneTr.length,
        ),
      ];
      M.ch = [0, 1, 2].map((j) => M.cs[0][j] + M.cs[1][j]);
      if (!om) M.st = "+";
      else if (M.ch.some(Boolean)) M.st = "~";
    }
  }
  compare(-1);
  const partsOf = (L) => [...L.parts, ...(cmp < 0 ? [] : L.gp)];
  const linksOf = (L) => [...L.links, ...(cmp < 0 ? [] : L.gl)];
  const groupSt = (G) => {
    const ks = kidsOfGroup(G);
    if (cmp < 0 || !ks.length) return "";
    if (ks.every((P) => P.st === "+")) return "+";
    if (ks.every((P) => P.st === "-")) return "-";
    return ks.some((P) => P.st) ? "~" : "";
  };
  const groupCh = (G) => kidsOfGroup(G).reduce((c, P) => c.map((x, j) => x + P.ch[j]), [0, 0, 0]);

  // ---- views: what one diagram shows
  const subOf = (n, plain) => {
    if (cmp < 0 || !n.st) return plain;
    if (n.kind === "file")
      return n.st === "~"
        ? `+${fmt(n.add)} −${fmt(n.del)} lines`
        : `${fmt(n.st === "+" ? n.add : n.del)} lines`;
    if (n.kind === "mach") return n.st === "~" ? changeWords(n.ch) : plain;
    return changeWords(n.ch) || plain;
  };
  const changeWords = (c) =>
    (c || [])
      .map((x, i) => x && `${fmt(x)} ${DID[i]}`)
      .filter(Boolean)
      .join(" · ");
  const box = (ref, key, label, sub, kind, x) =>
    Object.assign({ ref, key, label, sub, kind, pull: 0 }, x);
  const filesWords = (n) => (n && n.files !== undefined ? `${fmt(n.files)} files` : "");
  const moves = (E, a, b, m, ix, label) => {
    addEdge(E, a, b, 0, label ? `moves ${m.name}` : null);
    const e = E.get(`${a.key}>${b.key}`);
    if (label) e.label = `moves ${m.name}`;
    e.mv = e.mv || [];
    e.mv.push([m, ix]);
  };
  // a link between two boxes folds every map link between what they hold, and counts how each changed
  const addEdge = (E, a, b, n, why, st, old) => {
    const k = `${a.key}>${b.key}`;
    let e = E.get(k);
    if (!e) {
      e = { a, b, n: 0, w: 0, why, old, c: [0, 0, 0, 0], unk: false };
      E.set(k, e);
    }
    e.n += n;
    e.w += st === "-" ? 0 : n;
    if (st) e.c["+-~=".indexOf(st)]++;
    else if (n && cmp >= 0) e.unk = true;
  };
  const linkSt = (e) => {
    if (cmp < 0 || e.unk || !e.n) return "";
    const [a, r, m] = e.c;
    return a && !r && !m && !e.c[3]
      ? "+"
      : r && !a && !m && !e.c[3]
        ? "-"
        : a || r || m
          ? "~"
          : "=";
  };
  const partBox = (P) =>
    box(P, P.name, P.name, subOf(P, filesWords(P)), "part", { mach: allMachs(P) });
  const groupBox = (G) => {
    const ks = kidsOfGroup(G);
    return box(
      G,
      `g:${G.name}`,
      G.name,
      subOf({ st: groupSt(G), ch: groupCh(G) }, ks.length === 1 ? "1 part" : `${ks.length} parts`),
      "grp",
      { mach: ks.flatMap(allMachs) },
    );
  };
  function viewOf(ref) {
    const N = new Map();
    const E = new Map();
    const put = (b) => (N.has(b.key) ? N.get(b.key) : (N.set(b.key, b), b));
    let frame = null;
    if (ref.kind === "lvl" || ref.kind === "grp") {
      // a level shows its groups when its map file has them, a group shows its parts;
      // everything else it links to sits outside as a dashed box that opens where it lives
      const L = ref.kind === "lvl" ? ref : ref.lvl;
      const grouped = ref.kind === "lvl" && L.groups.length > 0;
      const mine = (x) => x.kind === "part" && (ref.kind === "lvl" || x.g === ref);
      if (ref.kind === "lvl" && L.part)
        for (const M of machsOf(L.part))
          put(box(M, `#${M.name}`, M.name, subOf(M, `${M.states.length} states`), "mach"));
      if (grouped) {
        for (const G of L.groups) if (kidsOfGroup(G).length) put(groupBox(G));
        for (const P of partsOf(L)) if (!P.g) put(partBox(P));
      } else for (const P of partsOf(L)) if (mine(P)) put(partBox(P));
      const end = (x) => {
        if (x.kind === "out")
          return put(box(x, `o:${x.name}`, x.name, x.about || "outside", "ext"));
        if (mine(x)) return N.get(grouped && x.g ? `g:${x.g.name}` : x.name);
        if (x.g) return put(box(x.g, `@g:${x.g.name}`, x.g.name, "another group", "ext"));
        return put(box(x, `@${x.name}`, x.name, "outside this group", "ext"));
      };
      for (const l of linksOf(L)) {
        if (!mine(l.a) && !mine(l.b)) continue;
        const A = end(l.a);
        const B = end(l.b);
        if (A && B && A !== B) addEdge(E, A, B, 1, l.why, l.st, l.old);
      }
      // a link from what makes a state machine's moves to the part that holds it says so
      for (const M of L.machs) {
        if (!M.holder || !mine(M.holder)) continue;
        const by = {};
        for (const [i, t] of M.tr.entries()) {
          if (!t[3]) continue;
          by[t[3]] = by[t[3]] || [];
          by[t[3]].push(i);
        }
        for (const [who, ix] of Object.entries(by)) {
          const x = L.names[who];
          if (!x) continue;
          const A = end(x);
          const B = end(M.holder);
          if (A && B && A !== B) moves(E, A, B, M, ix, true);
        }
      }
    } else if (ref.kind === "part") {
      // a part with no map of its own shows its machines, and in a comparison its changed files
      frame = { label: ref.path };
      for (const M of machsOf(ref))
        put(box(M, `#${M.name}`, M.name, subOf(M, `${M.states.length} states`), "mach"));
      if (cmp >= 0) {
        const order = { "+": 0, "~": 1, "-": 2 };
        for (const f of [...ref.fl].sort(
          (a, b) => order[a.st] - order[b.st] || b.add + b.del - a.add - a.del,
        ))
          put(box(f, `f:${f.name}`, f.name, subOf(f, ""), "file", { inFrame: true }));
        const same =
          ref.files === undefined ? 0 : ref.files - ref.fl.filter((f) => f.st !== "-").length;
        if (same > 0)
          put(
            box(
              null,
              "=",
              same === 1 ? "1 unchanged file" : `${fmt(same)} unchanged files`,
              "",
              "file",
              { inFrame: true, same: true },
            ),
          );
      }
      const ins = new Map();
      const outs = new Map();
      for (const l of linksOf(ref.lvl)) {
        const st = cmp < 0 || l.st === undefined || l.st === "=" ? "" : l.st;
        const side = (x, s, M) =>
          M.has(x.name) ||
          M.set(x.name, [
            put(
              box(
                x,
                `${s}${x.name}`,
                x.name,
                s === "<" ? "uses this part" : "used by this part",
                "ext",
                { side: s },
              ),
            ),
            st,
            cmp >= 0 && l.st === "=",
          ]);
        if (l.b === ref && l.a !== ref) side(l.a, "<", ins);
        if (l.a === ref && l.b !== ref) side(l.b, ">", outs);
      }
      Object.assign(frame, { ins: [...ins.values()], outs: [...outs.values()], more: [0, 0] });
    } else if (ref.kind === "mach") {
      const terminal = new Set(ref.states.filter((s) => !ref.tr.some((t) => t[0] === s)));
      ref.states.forEach((s, i) => {
        const sub = machByName[ref.opens[s]];
        const st = ref.sst[s];
        put(
          box(
            sub || null,
            s,
            s,
            st === "~"
              ? `was ${ref.o(s)}`
              : sub
                ? `opens ${sub.name}`
                : i === 0
                  ? "first state"
                  : terminal.has(s)
                    ? "final state"
                    : "",
            "state",
            { first: i === 0, end: terminal.has(s), openable: !!sub, st },
          ),
        );
      });
      for (const s of ref.goneSt) put(box(null, `-${s}`, s, "", "state", { st: "-" }));
      ref.tr.forEach(([a, b, why], k) => {
        const [st, old] = ref.tst[k] || [];
        if (N.has(a) && N.has(b))
          addEdge(
            E,
            N.get(a),
            N.get(b),
            0,
            st === "~" ? `${why} · was ${old}` : why,
            cmp < 0 || !ref.known ? null : st || "=",
          );
      });
      const at = (x) => N.get(ref.states.find((y) => ref.o(y) === x)) || N.get(`-${x}`);
      for (const [a, b, why] of ref.goneTr)
        if (at(a) && at(b)) addEdge(E, at(a), at(b), 0, why, "-");
      // what makes its moves waits on the left, linked to the states they move to
      const by = {};
      for (const [i, t] of ref.tr.entries()) {
        if (!t[3]) continue;
        by[t[3]] = by[t[3]] || [];
        by[t[3]].push(i);
      }
      for (const [who, ix] of Object.entries(by)) {
        const x = named(ref.lvl, who);
        if (!x) continue;
        const b = put(box(x, `@by:${who}`, who, "makes moves", "ext"));
        for (const i of ix) moves(E, b, N.get(ref.tr[i][1]), ref, [i]);
      }
    }
    const edges = [...E.values()];
    for (const e of edges) {
      e.st =
        ref.kind === "mach"
          ? cmp < 0 || !ref.known || e.mv
            ? ""
            : e.c[1]
              ? "-"
              : e.c[0]
                ? "+"
                : e.c[2]
                  ? "~"
                  : ""
          : e.mv
            ? ""
            : linkSt(e);
      if (e.st === "=") e.st = "";
      e.same = cmp >= 0 && !e.st && !e.unk && !e.mv && (ref.kind !== "mach" || ref.known);
      if (!e.label)
        e.label =
          e.n > 1
            ? e.st === "~"
              ? `${e.c[0] ? `+${fmt(e.c[0])} ` : ""}${e.c[1] ? `−${fmt(e.c[1])} ` : ""}${e.c[2] ? `~${fmt(e.c[2])} ` : ""}links`
              : `${fmt(e.n)} links`
            : e.st === "~" && e.old !== undefined && e.old !== e.why
              ? `${e.why} · was ${e.old}`
              : e.why || "";
    }
    // a box is as large as what uses it here
    for (const e of edges) if (e.a !== e.b) e.b.pull += e.w || 1;
    return { ref, nodes: [...N.values()], edges, frame };
  }

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
    // a tall column folds into two side by side
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

  // ---- drawing
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
  }

  // ---- words
  const files = (k) => `${fmt(k)} file${k === 1 ? "" : "s"}`;
  const sizeWords = (x) =>
    x && x.files !== undefined
      ? ` · ${files(x.files)}${x.lines !== undefined ? ` · ${fmt(x.lines)} lines` : ""}`
      : "";
  const chWords = (c) =>
    cmp >= 0 && c && c[0] + c[1] + c[2]
      ? ` · ${files(c[0])} added, ${fmt(c[1])} removed, ${fmt(c[2])} changed`
      : "";
  // a machine's change in words: states and moves counted apart
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
    if (touch) {
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

  // ---- input
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
  svg.addEventListener("pointerdown", (ev) => {
    if (ev.button) return;
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
    // a finger is never captured, so it scrolls the card; a mouse drags the map
    if (!finger) svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > (drag.finger ? 8 : 3)) drag.moved = true;
    if (!drag.moved || drag.finger) return;
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
    // on a touch screen the diagram is a picture: a tap opens it full screen
    if (d.finger) still();
    else if (d.m) go(pathTo(d.m));
    else {
      sel = d.n;
      mark();
    }
  });
  // the map takes its own presses: a card opens it as a still picture only when Full screen asks
  svg.addEventListener("click", (ev) => ev.preventDefault());
  // the double-click lands on the map too, so it opens the box the second press went down on
  svg.addEventListener("dblclick", (ev) => {
    if (!touch) enter(hit(ev) || downOn);
  });
  // a plain scroll is the card's, so it scrolls past the map; a pinch or ⌘- or Ctrl-scroll zooms at the pointer
  svg.addEventListener(
    "wheel",
    (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
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
    if (!target || touch) return;
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
  svg.addEventListener("keydown", (ev) => {
    const k = ev.key;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
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
    else if (k === "f" || k === "F") still();
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
  press("[data-fs]", still);
  press("[data-open]", () => enter(sel));
  press("[data-next]", () => stepTo(at + 1));
  press("[data-prev]", () => stepTo(at < 0 ? -1 : at - 1));
  press("[data-more]", () => {
    moreEl.hidden = !moreEl.hidden;
    moreBtn.setAttribute("aria-expanded", String(!moreEl.hidden));
  });
  if (!touch)
    $("[data-keys]").textContent =
      "Click or arrows choose · Enter goes in · Esc back · [ ] step through changes · ⌘-scroll zooms · F full screen";
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
  // a narrow card puts the comparison buttons under More
  let wide = 0;
  new ResizeObserver(() => {
    if (root.clientWidth === wide) return;
    wide = root.clientWidth;
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
  go(startAt ? pathTo(startAt) : cmp >= 0 ? where() : [top]);
})();
