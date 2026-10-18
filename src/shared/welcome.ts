import { COMPUTER } from "./deviceNames";
/**
 * The welcome note (FI3-1164, the captain's Approve and build;
 * docs/first-launch.md "The welcome"): a picture of the window that shows
 * one part per press, each with its words inside the picture beside the
 * thing it names, then three starters that put the start of an ask in the
 * message box. App copy, never a model's.
 */
/** Captain, INF-417: the previous screen already says welcome, so this card does not. */
export const WELCOME_TITLE = "How we work";

/** Each chapter's words, beside the part of the picture they name. */
export const WELCOME_WORDS = {
  box: "Type what you want done in the message box under this card.",
  card: "I bring back answers and choices as cards like this one.",
  activity: "Crewmates do the work in the background and report here.",
  tasks: "Every ask gets a record here.",
  end: "That is all of it. To begin, press a starter below.",
} as const;

export const WELCOME_STARTERS_LEAD = "To begin, press one and finish the sentence:";

/** Each starter's button, and the words its press puts in the message box. */
export const WELCOME_STARTERS = [
  { label: "Clone a project", words: "Clone the project at " },
  { label: "Start a new project", words: "Start a new project called " },
  { label: `Work in a folder on my ${COMPUTER.one}`, words: "Work in the folder " },
] as const;

/** The picture's own labels: its columns and the box. */
export const WELCOME_LABELS = {
  activity: "Activity",
  tasks: "Tasks",
  box: "the message box",
} as const;

/** The chapters as the picture counts them. */
export const WELCOME_CHAPTERS = 5;

const round = (value: number) => Math.round(value * 10) / 10;

/** A wire's color between the far side and the near one, as the character mixes it. */
const wire = (near: number) =>
  `color-mix(in srgb,var(--wire-accent) ${Math.round(near * 100)}%,var(--wire-dim))`;

/**
 * The Firstmate as a still, drawn the way the real character draws itself
 * (src/renderer/src/character/Firstmate.tsx, `drawFrame`): the tesseract
 * turned in its two planes and projected the same way, each wire and dot
 * shaded from the far cell to the near one, a faint glow behind it, and its
 * two soft-light eyes - a little larger and closer than the real ones, each
 * with a highlight.
 */
function firstmateStill(cx: number, cy: number, r: number): string {
  const xw = 0.2;
  const yz = 0.3;
  const points = Array.from({ length: 16 }, (_, i) => {
    const [x, y, z, w] = [1, 2, 4, 8].map((bit) => (i & bit ? 1 : -1)) as [
      number,
      number,
      number,
      number,
    ];
    const x1 = x * Math.cos(xw) - w * Math.sin(xw);
    const w1 = x * Math.sin(xw) + w * Math.cos(xw);
    const y1 = y * Math.cos(yz) - z * Math.sin(yz);
    const z1 = y * Math.sin(yz) + z * Math.cos(yz);
    const k4 = 2.6 / (2.6 - w1 * 0.55);
    const k3 = 3.4 / (3.4 - z1 * k4 * 0.5);
    return { x: cx + x1 * k4 * k3 * r * 0.5, y: cy + y1 * k4 * k3 * r * 0.5, w: w1 };
  });
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const wires: string[] = [];
  for (let i = 0; i < 16; i++) {
    for (const bit of [1, 2, 4, 8]) {
      const j = i | bit;
      if (j === i) continue;
      const p = points[i] as (typeof points)[number];
      const q = points[j] as (typeof points)[number];
      const near = clamp(0.5 + (p.w + q.w) * 0.35);
      wires.push(
        `<line x1="${round(p.x)}" y1="${round(p.y)}" x2="${round(q.x)}" y2="${round(q.y)}" style="stroke:${wire(near)};stroke-width:1.2;stroke-linecap:round;opacity:${round(0.7 + 0.25 * near)}"/>`,
      );
    }
  }
  const dots = points.map((p) => {
    const near = clamp(0.5 + p.w * 0.6);
    return `<circle cx="${round(p.x)}" cy="${round(p.y)}" r="${round((2.1 + 0.7 * near) * (r / 70))}" style="fill:${wire(Math.max(near, 0.35))}"/>`;
  });
  const eye = (side: number) => {
    const x = round(cx + side * r * 0.3);
    const y = round(cy - r * 0.06);
    const size = r * 0.105;
    return [
      `<circle cx="${x}" cy="${y}" r="${round(size * 2.3)}" style="fill:var(--accent-glow)"/>`,
      `<ellipse cx="${x}" cy="${y}" rx="${round(size)}" ry="${round(size * 1.3)}" style="fill:color-mix(in srgb,var(--wire-accent) 15%,#fff8eb);stroke:var(--wire-accent);stroke-width:0.8"/>`,
      `<circle cx="${round(x - size * 0.35)}" cy="${round(y - size * 0.5)}" r="${round(size * 0.32)}" style="fill:#fff"/>`,
    ].join("");
  };
  return [
    `<circle cx="${cx}" cy="${cy}" r="${round(r * 1.05)}" style="fill:var(--accent-glow);opacity:.3"/>`,
    ...wires,
    ...dots,
    eye(-1),
    eye(1),
  ].join("");
}

/** Words that flow inside the picture, at the card's small size. */
const words = (x: number, y: number, width: number, height: number, text: string, extra = "") =>
  `<foreignObject x="${x}" y="${y}" width="${width}" height="${height}"><div style="font-size:var(--text-sm);line-height:1.45;color:var(--fg-2)${extra}">${text}</div></foreignObject>`;

/**
 * The picture at rest is the whole explanation: every part with its words,
 * the card over the Firstmate as the window shows it, the box lit. The
 * script beside it starts it at the first chapter and shows one part per
 * press; without the script the card still reads whole.
 */
const PICTURE = `<svg viewBox="0 0 520 190" width="520" style="display:block;font-size:var(--text-sm)">
<rect x="0.5" y="0.5" width="519" height="189" rx="8" style="fill:var(--bg-1);stroke:var(--line-1)"/>
<g data-part="firstmate" style="visibility:hidden">${firstmateStill(263, 66, 50)}</g>
<g data-part="box"><rect data-look="box" x="190" y="122" width="140" height="18" rx="9" style="fill:none;stroke:var(--accent)"/><text data-look="box-label" x="260" y="135" text-anchor="middle" style="fill:var(--fg-1)">${WELCOME_LABELS.box}</text>
${words(140, 146, 240, 42, WELCOME_WORDS.box, ";text-align:center").replace("<div ", `<div data-part="words" data-last="${WELCOME_WORDS.end}" `)}</g>
<g data-part="card"><rect data-look="card" x="160" y="40" width="200" height="62" rx="6" style="fill:var(--bg-2);stroke:var(--line-2)"/>${words(171, 48, 180, 50, WELCOME_WORDS.card, ";color:var(--fg-1)")}</g>
<g data-part="activity"><line x1="130" y1="1" x2="130" y2="189" style="stroke:var(--line-1)"/><text x="14" y="24" style="fill:var(--fg-1)">${WELCOME_LABELS.activity}</text>
<g style="fill:var(--line-2)"><circle cx="18" cy="42" r="2.5"/><rect x="26" y="40.5" width="88" height="3" rx="1.5"/><circle cx="18" cy="58" r="2.5"/><rect x="26" y="56.5" width="70" height="3" rx="1.5"/><circle cx="18" cy="74" r="2.5"/><rect x="26" y="72.5" width="94" height="3" rx="1.5"/></g>
${words(12, 88, 112, 98, WELCOME_WORDS.activity)}
<path data-look="crew" d="M374 12l9 16h-18zM374 12v16" style="fill:none;stroke:var(--line-2);stroke-linejoin:round"/><path d="M364 24C300 18 200 26 132 40" style="fill:none;stroke:var(--line-2);stroke-dasharray:3 3"/></g>
<g data-part="tasks"><line x1="390" y1="1" x2="390" y2="189" style="stroke:var(--line-1)"/><text x="404" y="24" style="fill:var(--fg-1)">${WELCOME_LABELS.tasks}</text>
<g style="fill:var(--line-2)"><rect data-look="task" x="404" y="40.5" width="96" height="3" rx="1.5"/><rect x="404" y="56.5" width="72" height="3" rx="1.5"/><rect x="404" y="72.5" width="84" height="3" rx="1.5"/></g>
${words(402, 88, 112, 98, WELCOME_WORDS.tasks)}</g>
</svg>`;

/**
 * The controls under the picture, which only the script shows: the dots
 * and a count, then Back and Next. Without the script nothing here is drawn,
 * so nothing on the card looks pressable that is not.
 */
const STEPS = `<div data-welcome-steps hidden><div style="display:flex;align-items:center;gap:var(--space-3);margin-top:var(--space-2);max-width:520px">
<span data-dots style="display:inline-flex;gap:6px" aria-hidden="true">${'<span style="width:7px;height:7px;border-radius:50%;border:1px solid var(--line-2)"></span>'.repeat(WELCOME_CHAPTERS)}</span>
<span data-count style="font-family:var(--font-mono);font-size:var(--text-xs);color:var(--fg-3)">1 / ${WELCOME_CHAPTERS}</span>
<span style="margin-left:auto;display:inline-flex;gap:var(--space-2)"><button type="button" data-step="back">Back</button><button type="button" data-step="next">Next</button></span>
</div></div>`;

/**
 * One chapter per press (the figure's own script, docs/card-authoring.md
 * "Scripting"): the parts each chapter adds, the one lit part, a pass of
 * --dur-med for Next (a cut when reduced motion zeroes it), a cut for Back.
 */
const PRESENTATION_SCRIPT = `<script>
(function () {
  var figure = document.currentScript.closest("figure");
  var steps = figure.querySelector("[data-welcome-steps]");
  var back = figure.querySelector('[data-step="back"]');
  var next = figure.querySelector('[data-step="next"]');
  var count = figure.querySelector("[data-count]");
  var dots = figure.querySelectorAll("[data-dots] > span");
  var said = figure.querySelector('[data-part="words"]');
  var first = said.textContent;
  var last = said.getAttribute("data-last");
  var ADDS = [["firstmate", "box"], ["card"], ["activity"], ["tasks"], []];
  var LIT = ["box", "card", "crew", "task", "box"];
  var LOOKS = {
    "box": [["stroke", "var(--accent)", "var(--line-2)"]],
    "box-label": [["fill", "var(--fg-1)", "var(--fg-3)"]],
    "card": [["fill", "var(--accent-dim)", "var(--bg-2)"], ["stroke", "var(--accent)", "var(--line-2)"]],
    "crew": [["stroke", "var(--accent)", "var(--line-2)"]],
    "task": [["fill", "var(--accent)", "var(--line-2)"]]
  };
  var chapter = 1;
  function part(name) { return figure.querySelector('[data-part="' + name + '"]'); }
  function token(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function duration() {
    var value = token("--dur-med");
    var n = parseFloat(value) || 0;
    return /ms$/.test(value) ? n : n * 1000;
  }
  function draw(moved) {
    var pass = moved ? duration() : 0;
    var ease = token("--ease-out") || "ease-out";
    figure.getAnimations({ subtree: true }).forEach(function (running) { running.cancel(); });
    for (var c = 0; c < ADDS.length; c++) {
      for (var p = 0; p < ADDS[c].length; p++) {
        var element = part(ADDS[c][p]);
        var shown = c < chapter && !(ADDS[c][p] === "firstmate" && chapter > 1);
        element.style.visibility = shown ? "visible" : "hidden";
        if (pass > 0 && shown && c === chapter - 1) {
          element.animate([{ opacity: 0, transform: "translateY(" + (c === 1 ? 10 : 6) + "px)" }, { opacity: 1, transform: "none" }], { duration: pass, easing: ease });
        }
      }
    }
    var firstmate = part("firstmate");
    if (pass > 0 && chapter === 2) {
      firstmate.style.visibility = "visible";
      firstmate.animate([{ opacity: 1 }, { opacity: 0 }], { duration: pass, easing: ease, fill: "forwards" }).onfinish = function () {
        firstmate.style.visibility = "hidden";
      };
    }
    var words = chapter === ADDS.length ? last : first;
    if (said.textContent !== words) {
      said.textContent = words;
      if (pass > 0) said.animate([{ opacity: 0 }, { opacity: 1 }], { duration: pass, easing: ease });
    }
    var lit = LIT[chapter - 1];
    figure.querySelectorAll("[data-look]").forEach(function (element) {
      var look = element.getAttribute("data-look");
      var on = look === lit || look === lit + "-label";
      (LOOKS[look] || []).forEach(function (rule) { element.style[rule[0]] = on ? rule[1] : rule[2]; });
    });
    dots.forEach(function (dot, i) {
      dot.style.background = i === chapter - 1 ? "var(--accent)" : i < chapter - 1 ? "var(--line-2)" : "transparent";
      dot.style.borderColor = i === chapter - 1 ? "var(--accent)" : "var(--line-2)";
    });
    count.textContent = chapter + " / " + ADDS.length;
    figure.setAttribute("data-chapter", String(chapter));
    [[back, chapter === 1], [next, chapter === ADDS.length]].forEach(function (pair) {
      pair[0].setAttribute("aria-disabled", pair[1] ? "true" : "false");
      pair[0].style.opacity = pair[1] ? "0.4" : "";
      pair[0].style.cursor = pair[1] ? "default" : "";
    });
  }
  next.addEventListener("click", function () {
    if (chapter === ADDS.length) return;
    chapter += 1;
    draw(true);
  });
  back.addEventListener("click", function () {
    if (chapter === 1) return;
    chapter -= 1;
    draw(false);
  });
  steps.hidden = false;
  draw(false);
})();
</script>`;

/** Each starter is a button the frame bridge carries to the message box (`data-inf-draft`). */
const STARTERS = `<p>${WELCOME_STARTERS_LEAD}</p>
<div style="display:flex;flex-wrap:wrap;gap:var(--space-2)">${WELCOME_STARTERS.map(
  (starter) => `<button type="button" data-inf-draft="${starter.words}">${starter.label}</button>`,
).join("")}</div>`;

export const WELCOME_BODY = `<figure aria-label="Your window, one part per press: the message box, a card, Activity and Tasks" style="margin:0 0 var(--space-3)">
${PICTURE}
${STEPS}
${PRESENTATION_SCRIPT}
</figure>
${STARTERS}`;

/**
 * The welcome in words, as its record keeps it: the answer its task holds
 * and the introduction the Firstmate's context carries. The body's picture
 * and script would cost every turn and say nothing a model reads.
 */
export const WELCOME_ANSWER = `<p>A picture of the window, one part per press, each with its words:</p>
<ul>
<li>The message box: ${WELCOME_WORDS.box}</li>
<li>A card: ${WELCOME_WORDS.card}</li>
<li>${WELCOME_LABELS.activity}, on the left: ${WELCOME_WORDS.activity}</li>
<li>${WELCOME_LABELS.tasks}, on the right: ${WELCOME_WORDS.tasks}</li>
</ul>
<p>${WELCOME_STARTERS_LEAD} ${WELCOME_STARTERS.map(
  (starter) => `${starter.label} (puts “${starter.words.trim()}” in the message box)`,
).join(", ")}.</p>`;

/** The note the host presents: its title, its body, and the answer its record keeps. */
export const WELCOME_NOTE = { title: WELCOME_TITLE, body: WELCOME_BODY, answer: WELCOME_ANSWER };
