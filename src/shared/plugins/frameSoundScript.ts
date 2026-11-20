/**
 * Trusted bridge code for a card's sound clips (docs/card-authoring.md,
 * "Sound clips"), spliced into `FRAME_BRIDGE_SCRIPT`: `decorateSounds()` draws
 * a Listen button with the clip's length at the start of each
 * `figure[data-inf-sound]` the host verified, once the host says it plays
 * sound (`caps.sound`), so a surface that plays none draws no button. A press
 * on it posts the clip's served name, its caption and its length; the host
 * plays it in the card's own sound strip, and only on the captain's own
 * press. The body itself never loads the clip: its policy loads no media.
 */
import { FRAME_DEMO_CAPTION_MAX, FRAME_DEMO_SOURCE } from "./bridge";

export const FRAME_SOUND_SCRIPT = `  // A clip's length as the strip's clock shows it, m:ss, and in words.
  var soundClock = function (ms) {
    var whole = Math.max(1, Math.round(ms / 1000));
    return Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0");
  };
  var soundWords = function (ms) {
    var whole = Math.max(1, Math.round(ms / 1000));
    var minutes = Math.floor(whole / 60);
    var seconds = whole % 60;
    var said = [];
    if (minutes) said.push(minutes + (minutes === 1 ? " minute" : " minutes"));
    if (seconds) said.push(seconds + (seconds === 1 ? " second" : " seconds"));
    return said.join(" ");
  };
  var decorateSounds = function () {
    if (!caps.sound || !document.body) return;
    var figures = document.querySelectorAll("figure[data-inf-sound]:not([data-inf-sound-ready])");
    for (var i = 0; i < figures.length; i++) {
      var figure = figures[i];
      var src = figure.getAttribute("data-inf-sound") || "";
      if (src.indexOf(${JSON.stringify(FRAME_DEMO_SOURCE)}) !== 0) continue;
      figure.setAttribute("data-inf-sound-ready", "");
      var ms = Math.round(Number(figure.getAttribute("data-inf-sound-duration")));
      ms = ms > 0 ? ms : 0;
      var button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-inf-sound-play", "");
      button.setAttribute("aria-label", ms ? "Listen, " + soundWords(ms) : "Listen");
      button.textContent = ms ? "Listen \\u00b7 " + soundClock(ms) : "Listen";
      listen.call(button, "click", function (event) {
        var at = event.currentTarget.closest("figure[data-inf-sound]");
        if (!at) return;
        var caption = at.querySelector("figcaption");
        post({
          type: "sound",
          src: at.getAttribute("data-inf-sound") || "",
          caption: caption ? (caption.textContent || "").replace(/\\s+/g, " ").trim().slice(0, ${FRAME_DEMO_CAPTION_MAX}) : "",
          durationMs: Math.max(0, Math.round(Number(at.getAttribute("data-inf-sound-duration"))) || 0)
        });
      });
      figure.insertBefore(button, figure.firstChild);
    }
  };
`;
