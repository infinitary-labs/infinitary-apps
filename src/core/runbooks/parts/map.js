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
  const fsBtn = $("[data-fs]");
  // a touch screen draws the diagram as a fitted picture: one finger scrolls the card past it, a tap opens it
  const touch = matchMedia("(hover: none) and (pointer: coarse)").matches;
  root.classList.toggle("touch", touch);
  // full screen: the app opened this body again over its window, at the state the card's map stood at
  const opened = window.inf?.expanded?.(root) || null;
  const full = !!opened && typeof opened === "object";
  // the card's bridge shows only the map, filling the window, and hands a pinch over as ⌘-scroll
  root.classList.toggle("full", full);
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

