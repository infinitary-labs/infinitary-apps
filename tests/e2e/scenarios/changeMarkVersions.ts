import type { Scenario } from "../mockProvider";

/**
 * What changed since the captain looked (the accepted FI3-472 plan): the
 * Firstmate puts one card up and revises it under the same id, one version
 * per captain turn - "show the change marks at version 3". Its cards redraw
 * at once, so each turn is one revision on the stage.
 */
export const CHANGE_MARKS_PROMPT_MARKER = "show the change marks at version ";

export const CHANGE_MARKS_TITLE = "Two ways to fix the flaky upload test";

const CHANGE_MARKS_FIGURE = (fill: string, label: string) =>
  `<figure aria-label="${label}"><svg viewBox="0 0 510 40" width="100%" role="img" aria-label="${label}"><rect x="0" y="8" width="510" height="24" rx="6" style="fill:${fill}"/></svg></figure>`;

const CHANGE_MARKS_V2 =
  "<p>The upload test fails when the queue drains late.</p>" +
  "<p>Mocking the clock also fixes the retry failure you asked about.</p>" +
  "<ul><li>Mock the clock: 12 lines, tests only</li><li>Await the queue: 40 lines, touches the uploader</li></ul>" +
  "<table><tr><th>Route</th><th>Lines</th></tr><tr><td>Mock the clock</td><td>12</td></tr><tr><td>Await the queue</td><td>40</td></tr></table>" +
  CHANGE_MARKS_FIGURE("var(--bg-3)", "Ten runs before the fix") +
  "<p>Evidence is in the CI log.</p>";

const CHANGE_MARKS_QUESTION =
  '<fieldset><legend>Which route?</legend><label><input type="radio" name="route" value="clock" checked> Mock the clock</label><label><input type="radio" name="route" value="queue"> Await the queue</label><label><input type="radio" name="route" value="other" data-inf-write-in> Something else</label></fieldset>';

/** The figure version 7 adds: ten runs, one more on each press of Next run. */
const CHANGE_MARKS_PLAYABLE_FIGURE =
  '<figure aria-label="Ten runs after the fix, one more on each press">' +
  '<button type="button">Next run</button>' +
  '<svg viewBox="0 0 510 64" width="100%" role="img" aria-label="Ten runs, all passed">' +
  Array.from(
    { length: 10 },
    (_, i) =>
      `<rect data-run x="${i * 51}" y="8" width="45" height="24" rx="6" style="fill:var(--ok);transition:opacity var(--dur-med) var(--ease-out)"/>`,
  ).join("") +
  '<text data-runs-label x="0" y="54" style="fill:var(--fg-2)">10 of 10 passed</text>' +
  "</svg>" +
  "<script>(function(){var figure=document.currentScript.closest('figure');var runs=figure.querySelectorAll('[data-run]');var label=figure.querySelector('[data-runs-label]');var shown=runs.length;figure.querySelector('button').addEventListener('click',function(){shown=shown%runs.length+1;runs.forEach(function(run,i){run.style.opacity=i<shown?'1':'0';});label.textContent=shown+' of '+runs.length+' passed';});})();</script>" +
  "</figure>";

/** Each version's body, by the number the captain names. */
export const CHANGE_MARKS_VERSIONS: Record<number, string> = {
  1:
    "<p>The upload test fails when the queue drains late.</p>" +
    "<ul><li>Mock the clock: 12 lines, tests only</li><li>Rewrite the uploader: 200 lines</li></ul>" +
    "<table><tr><th>Route</th><th>Lines</th></tr><tr><td>Mock the clock</td><td>12</td></tr></table>" +
    CHANGE_MARKS_FIGURE("var(--bg-3)", "Ten runs before the fix") +
    "<p>Evidence is in the CI log.</p>",
  // One new paragraph, one list item and one table row changed or added.
  2: CHANGE_MARKS_V2,
  // A question, then (unseen) a new drawing: marked together.
  3: CHANGE_MARKS_V2 + CHANGE_MARKS_QUESTION,
  4:
    CHANGE_MARKS_V2.replace(
      CHANGE_MARKS_FIGURE("var(--bg-3)", "Ten runs before the fix"),
      CHANGE_MARKS_FIGURE("var(--ok-dim)", "Ten runs after the fix, all passed"),
    ) + CHANGE_MARKS_QUESTION,
  // Rewritten: more than half the card is new.
  5:
    "<p>Await the queue: the race is gone in production too.</p>" +
    "<ul><li>40 lines in the uploader</li><li>One new test for the drain</li></ul>" +
    "<p>Ten runs passed on the Mac and in CI.</p>",
  // A playable preview: its own script draws it, so only the line says what changed.
  6:
    "<p>Await the queue: the race is gone in production too.</p>" +
    "<ul><li>40 lines in the uploader</li><li>One new test for the drain</li></ul>" +
    "<p>Ten runs passed on the Mac and in CI.</p>" +
    "<p>Drag to replay the ten runs.</p>" +
    '<canvas id="runs" width="510" height="40"></canvas>' +
    "<script>const c=document.getElementById('runs').getContext('2d');c.fillStyle=getComputedStyle(document.body).getPropertyValue('--ok');c.fillRect(0,8,510,24);</script>",
  // A figure that moves: its script sits inside it, so the card is still
  // prose and is marked like any other.
  7:
    "<p>Await the queue: the race is gone in production too.</p>" +
    "<ul><li>40 lines in the uploader</li><li>One new test for the drain</li></ul>" +
    "<p>Ten runs passed on the Mac and in CI.</p>" +
    "<p>Press Next run to replay the ten runs one at a time.</p>" +
    CHANGE_MARKS_PLAYABLE_FIGURE,
};

/** The first mate revises one card through its numbered versions, so each revision's marks show. */
export const changeMarkVersions: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    if (!hasToolResults && latestUserTail.includes(CHANGE_MARKS_PROMPT_MARKER)) {
      const version = Number(
        latestUserTail.match(new RegExp(`${CHANGE_MARKS_PROMPT_MARKER}(\\d)`))?.[1],
      );
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              id: "change-marks",
              title: CHANGE_MARKS_TITLE,
              body: CHANGE_MARKS_VERSIONS[version] ?? "<p>No such version.</p>",
              actions: [
                { id: "clock", label: "Mock the clock" },
                { id: "queue", label: "Await the queue", default: true },
              ],
              standalone: true,
            },
          },
        ],
      };
    }
    return undefined;
  };
