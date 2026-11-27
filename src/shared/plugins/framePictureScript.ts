/**
 * Trusted bridge code for a card body's pictures, spliced into
 * `FRAME_BRIDGE_SCRIPT` (./frameScript.ts), whose click and key handlers
 * open them: a group's pictures and its "+N" tile, a verified demo's Play
 * button with the recording's length under its poster (docs/card-authoring.md,
 * "Demo recordings"), and a diagram as a picture, its look written on each
 * element (INF-3107). `tagPictures()` makes each picture a click would open a
 * Tab stop once the host says it opens pictures (`caps.pictures`).
 */
import {
  DRAWING_LOOK,
  DRAWING_SOURCE_PREFIX,
  DRAWING_WORDS_LOOK,
  FRAME_DEMO_CAPTION_MAX,
  FRAME_DEMO_SOURCE,
  FRAME_MAX_PICTURES,
  FRAME_PICTURE_ALT_MAX,
  FRAME_PICTURE_WHERE_MAX,
  PICTURE_STRIP_SHOWN,
} from "./bridge";

export const FRAME_PICTURE_SCRIPT = `  var STRIP_SHOWN = ${PICTURE_STRIP_SHOWN};
  function groupPictures(group) {
    var pictures = [];
    for (var i = 0; i < group.children.length; i++) {
      if (group.children[i].tagName === "IMG") pictures.push(group.children[i]);
    }
    return pictures;
  }
  // The pictures of one part of the body, in reading order: its own pictures and
  // drawings, never a drawing inside another.
  function partPictures(holder) {
    var found = holder.querySelectorAll("img, svg");
    var pictures = [];
    for (var i = 0; i < found.length; i++) {
      if (!found[i].parentElement || !found[i].parentElement.closest("svg")) pictures.push(found[i]);
    }
    return pictures;
  }
  // The part of the body a picture is in, when the host marked its parts, and
  // which of that part's pictures it is: a place marked in the viewer is a note
  // on that part.
  function withPart(element, picture) {
    var holder = element.closest("[data-inf-target]");
    var start = holder ? holder.getAttribute("data-inf-target") : null;
    if (start === null || !/^\\d+$/.test(start)) return picture;
    picture.part = Number(start);
    if (holder !== element) {
      var of = partPictures(holder).indexOf(element);
      if (of >= 0) picture.of = of + 1;
    }
    return picture;
  }
  // The pictures a press on this one opens, and which of them it is: every
  // picture of the body a press opens, in reading order (INF-7148), so a
  // story's Before and After, each alone in its cell, are neighbours. A
  // picture inside a control and a demo's poster are never in it: a press
  // there does something else. Past the most one message carries, the set is
  // the window around the pressed picture.
  var MAX_PICTURES = ${FRAME_MAX_PICTURES};
  function bodyPictures() {
    var found = document.querySelectorAll("img");
    var pictures = [];
    for (var i = 0; i < found.length; i++) {
      var picture = found[i];
      if (picture.closest(PICTURE_CONTROL)) continue;
      var demo = demoOf(picture.closest("figure[data-inf-demo]"));
      if (demo && demo.poster === picture) continue;
      pictures.push(picture);
    }
    return pictures;
  }
  function pictureSet(picture) {
    var members = bodyPictures();
    var index = members.indexOf(picture);
    if (index < 0) {
      members = [picture];
      index = 0;
    }
    if (members.length > MAX_PICTURES) {
      var start = Math.min(Math.max(index - Math.floor(MAX_PICTURES / 2), 0), members.length - MAX_PICTURES);
      members = members.slice(start, start + MAX_PICTURES);
      index -= start;
    }
    return { index: index, pictures: members.map(describePicture) };
  }
  var WHERE_MAX = ${FRAME_PICTURE_WHERE_MAX};
  function wordsOf(element) {
    return (element.textContent || "").replace(/\\s+/g, " ").trim();
  }
  // What the card calls a picture's place, so the viewer can say which of two
  // near-identical pictures is After: the header cell above its table column,
  // counting spanned columns, else the nearest heading before it.
  function whereOf(picture) {
    var cell = picture.closest("td, th");
    var table = cell ? cell.closest("table") : null;
    var head = table ? table.querySelector("thead tr") || table.rows[0] : null;
    if (head && head !== cell.parentElement) {
      var column = 0;
      for (var before = cell.previousElementSibling; before; before = before.previousElementSibling) column += before.colSpan || 1;
      var at = 0;
      for (var header = head.firstElementChild; header; header = header.nextElementSibling) {
        at += header.colSpan || 1;
        if (column >= at) continue;
        var named = header.tagName === "TH" ? wordsOf(header) : "";
        if (named) return named.slice(0, WHERE_MAX);
        break;
      }
    }
    var headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
    var nearest = "";
    for (var i = 0; i < headings.length; i++) {
      if (!(headings[i].compareDocumentPosition(picture) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
      nearest = wordsOf(headings[i]);
    }
    return nearest.slice(0, WHERE_MAX);
  }
  function describePicture(picture) {
    var described = {
      src: picture.currentSrc || picture.src,
      alt: picture.getAttribute("alt") || "",
      width: picture.naturalWidth || 0,
      height: picture.naturalHeight || 0
    };
    var where = whereOf(picture);
    if (where) described.where = where;
    return withPart(picture, described);
  }
  // The set a note's mark is shown in: the picture its place names in its part.
  function partPictureSet(holder, of) {
    var picture = of ? partPictures(holder)[of - 1] : holder;
    if (!picture) return null;
    if (picture.tagName === "IMG") {
      var demo = demoOf(picture.closest("figure[data-inf-demo]"));
      return demo && demo.poster === picture ? null : pictureSet(picture);
    }
    if (picture.namespaceURI === SVG_SPACE && outermostDrawing(picture) === picture && isDiagram(picture)) {
      return { index: 0, pictures: [drawingPicture(picture)] };
    }
    return null;
  }
  function openPicture(picture) {
    var demo = demoOf(picture.closest("figure[data-inf-demo]"));
    if (demo && demo.poster === picture) {
      showDemo(demo, false);
      return;
    }
    var set = pictureSet(picture);
    post({ type: "image", index: set.index, pictures: set.pictures });
  }
  var DEMO_SOURCE = ${JSON.stringify(FRAME_DEMO_SOURCE)};
  var DEMO_CAPTION_MAX = ${FRAME_DEMO_CAPTION_MAX};
  function demoOf(figure) {
    if (!figure || !figure.hasAttribute("data-inf-demo")) return null;
    var src = figure.getAttribute("data-inf-demo") || "";
    var poster = figure.querySelector("img");
    if (src.indexOf(DEMO_SOURCE) !== 0 || !poster) return null;
    return { figure: figure, src: src, poster: poster, sound: figure.getAttribute("data-inf-demo-sound") === "true" };
  }
  function demoMs(figure) {
    var ms = Math.round(Number(figure.getAttribute("data-inf-demo-duration")));
    return ms > 0 && ms < 600000 ? ms : 0;
  }
  function showDemo(demo, play) {
    var caption = demo.figure.querySelector("figcaption");
    var poster = demo.poster;
    post({
      type: "demo",
      src: demo.src,
      play: play,
      sound: demo.sound,
      durationMs: demoMs(demo.figure),
      caption: caption ? (caption.textContent || "").replace(/\\s+/g, " ").trim().slice(0, DEMO_CAPTION_MAX) : "",
      poster: {
        src: poster.currentSrc || poster.src,
        alt: poster.getAttribute("alt") || "",
        width: poster.naturalWidth || 0,
        height: poster.naturalHeight || 0
      }
    });
  }
  // Each verified demo gets its Play button, with the recording's length,
  // under its poster: drawn with the body, so it is part of its first drawing.
  // A figure is done only once it has its button: the parser can pause after
  // the figure's start tag, before its poster, and the next change draws it.
  function decorateDemos() {
    if (!document.body) return false;
    var figures = document.querySelectorAll("figure[data-inf-demo]:not([data-inf-demo-ready])");
    var drawn = false;
    for (var i = 0; i < figures.length; i++) {
      var demo = demoOf(figures[i]);
      if (!demo) continue;
      figures[i].setAttribute("data-inf-demo-ready", "");
      var seconds = Math.max(1, Math.round(demoMs(demo.figure) / 1000));
      var button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-inf-demo-play", "");
      button.setAttribute("aria-label", "Play the demo" + (demo.sound ? " with sound" : "") + ", " + seconds + (seconds === 1 ? " second" : " seconds"));
      button.textContent = "Play \u00b7 " + seconds + " s" + (demo.sound ? " \u00b7 sound" : "");
      demo.poster.insertAdjacentElement("afterend", button);
      drawn = true;
    }
    return drawn;
  }
  var PICTURE_CONTROL = "a, button, summary, label, [data-inf-action]";
  var UNSHOWN_PICTURE = ".inf-pictures > img:nth-of-type(n+7)";
  // A diagram (INF-3107): an inline drawing a press opens in the picture
  // viewer, as a picture does - the outermost drawing in a figure, or one
  // drawn the width of what holds it. A small mark beside words, a drawing
  // inside a control and one in a caption are not diagrams.
  var DRAWING_CONTROL = PICTURE_CONTROL + ", input, select, textarea, figcaption, [data-inf-tradeoff-pick]";
  function outermostDrawing(element) {
    var drawing = element && element.closest ? element.closest("svg") : null;
    while (drawing && drawing.parentElement && drawing.parentElement.closest("svg")) {
      drawing = drawing.parentElement.closest("svg");
    }
    return drawing;
  }
  function isDiagram(drawing) {
    if (!drawing || drawing.closest(DRAWING_CONTROL)) return false;
    var figure = drawing.closest("figure");
    if (figure && !figure.hasAttribute("data-inf-demo")) return true;
    var holder = drawing.parentElement;
    if (!holder) return false;
    var space = getComputedStyle(holder);
    if (/^(inline|contents|none)/.test(space.display)) return false;
    var room = holder.clientWidth - (parseFloat(space.paddingLeft) || 0) - (parseFloat(space.paddingRight) || 0);
    return room > 0 && drawing.getBoundingClientRect().width >= room - 1;
  }
  // The diagram as it stands, whole on its own: every element keeps the
  // look the card gave it - the theme's colors, the author's classes, the
  // stylesheet's type - written on the element, with the card's own faces
  // for the families it uses, at its own size, one unit to a pixel. No
  // script and no handler goes with it; the host shows it as a picture,
  // which runs nothing and loads nothing.
  var SVG_SPACE = "http://www.w3.org/2000/svg";
  var DRAWING_LOOK = ${JSON.stringify(DRAWING_LOOK)};
  var DRAWING_WORDS_LOOK = ${JSON.stringify(DRAWING_WORDS_LOOK)};
  function lookOf(element, names, families) {
    var computed = getComputedStyle(element);
    var look = "";
    for (var i = 0; i < names.length; i++) {
      var value = computed.getPropertyValue(names[i]);
      if (value) look += names[i] + ":" + value + ";";
    }
    computed.fontFamily.split(",").forEach(function (family) {
      families[family.trim().replace(/^["']|["']$/g, "").toLowerCase()] = true;
    });
    return look;
  }
  function facesFor(families) {
    var faces = "";
    for (var i = 0; i < document.styleSheets.length; i++) {
      var rules;
      try { rules = document.styleSheets[i].cssRules; } catch (error) { continue; }
      for (var j = 0; j < rules.length; j++) {
        var rule = rules[j];
        if (rule.type !== 5) continue;
        var family = rule.style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, "").toLowerCase();
        if (families[family]) faces += rule.cssText + "\\n";
      }
    }
    return faces;
  }
  function drawingPicture(drawing) {
    var copy = drawing.cloneNode(true);
    var from = [drawing].concat(Array.prototype.slice.call(drawing.querySelectorAll("*")));
    var to = [copy].concat(Array.prototype.slice.call(copy.querySelectorAll("*")));
    var families = {};
    var scripts = [];
    for (var i = 0; i < from.length; i++) {
      var element = to[i];
      if (element.localName === "script") { scripts.push(element); continue; }
      for (var a = element.attributes.length - 1; a >= 0; a--) {
        if (/^on/i.test(element.attributes[a].name)) element.removeAttribute(element.attributes[a].name);
      }
      element.removeAttribute("tabindex");
      element.removeAttribute("data-inf-picture");
      element.setAttribute("style", lookOf(from[i], from[i].namespaceURI === SVG_SPACE ? DRAWING_LOOK : DRAWING_WORDS_LOOK, families));
      // A still the stage part drew over shows in the picture, since the live
      // drawing beside it does not travel (docs/card-authoring.md, "The app's own stage").
      if (from[i].hasAttribute("data-inf-stage-still")) element.style.removeProperty("display");
    }
    scripts.forEach(function (script) { script.remove(); });
    var box = drawing.viewBox && drawing.viewBox.baseVal;
    var drawn = drawing.getBoundingClientRect();
    var width = box && box.width > 0 ? box.width : drawn.width;
    var height = box && box.height > 0 ? box.height : drawn.height;
    if (!(box && box.width > 0 && box.height > 0)) copy.setAttribute("viewBox", "0 0 " + width + " " + height);
    copy.setAttribute("width", String(width));
    copy.setAttribute("height", String(height));
    var faces = facesFor(families);
    if (faces) {
      var sheet = document.createElementNS(SVG_SPACE, "style");
      sheet.textContent = faces;
      copy.insertBefore(sheet, copy.firstChild);
    }
    var figure = drawing.closest("figure");
    var caption = figure ? figure.querySelector("figcaption") : null;
    var words = caption ? caption.textContent : (figure && figure.getAttribute("aria-label")) || drawing.getAttribute("aria-label") || "";
    return withPart(drawing, {
      src: ${JSON.stringify(DRAWING_SOURCE_PREFIX)} + encodeURIComponent(new XMLSerializer().serializeToString(copy)),
      alt: (words || "").replace(/\\s+/g, " ").trim().slice(0, ${FRAME_PICTURE_ALT_MAX}),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height))
    });
  }
  function openDrawing(drawing) {
    post({ type: "image", index: 0, pictures: [drawingPicture(drawing)] });
  }
  function tagPictures() {
    decorateSounds();
    if (!caps.pictures || !document.body) return;
    var pictures = document.querySelectorAll("img:not([data-inf-picture]):not([tabindex])");
    var tagged = false;
    for (var i = 0; i < pictures.length; i++) {
      var picture = pictures[i];
      if (picture.closest(PICTURE_CONTROL) || picture.matches(UNSHOWN_PICTURE)) continue;
      picture.setAttribute("data-inf-picture", "");
      picture.setAttribute("tabindex", "0");
      tagged = true;
    }
    var drawings = document.querySelectorAll("svg:not([data-inf-picture]):not([tabindex])");
    for (var d = 0; d < drawings.length; d++) {
      var drawing = drawings[d];
      if (outermostDrawing(drawing) !== drawing || !isDiagram(drawing)) continue;
      drawing.setAttribute("data-inf-picture", "");
      drawing.setAttribute("tabindex", "0");
      tagged = true;
    }
    if (!tagged) return;
    // The same pictures in the same place: a stop for the keyboard is not the body changing.
    sizeWatch.takeRecords();
  }
  function moreTileIndex(group, x, y) {
    var pictures = groupPictures(group);
    if (pictures.length <= STRIP_SHOWN) return -1;
    var tile = getComputedStyle(group, "::after");
    if (tile.content === "none" || tile.display === "none") return -1;
    var last = pictures[STRIP_SHOWN - 1];
    var lastBox = last.getBoundingClientRect();
    var box = group.getBoundingClientRect();
    var width = parseFloat(tile.width) || 0;
    var height = parseFloat(tile.height) || 0;
    var left = lastBox.right + (parseFloat(getComputedStyle(group).columnGap) || 0);
    var top = lastBox.top;
    if (left + width > box.right + 0.5) {
      left = box.left;
      top = lastBox.bottom + (parseFloat(getComputedStyle(last).marginBottom) || 0);
    }
    return x >= left && x <= left + width && y >= top && y <= top + height ? STRIP_SHOWN : -1;
  }`;
