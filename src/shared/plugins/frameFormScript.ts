/**
 * Trusted bridge code for a card body's form, spliced into
 * `FRAME_BRIDGE_SCRIPT` (./frameScript.ts), whose message listener starts,
 * fills and reads it. `FRAME_QUESTION_SCRIPT` and `FRAME_TAG_SCRIPT` are
 * spliced in here, where they read the form's own helpers.
 *
 * A card body's FORM is the bridge's to watch (inline decisions, contract
 * 4.22; docs/card-authoring.md "Questions in the body"). Once the host says
 * so - a `form` message, which only a card mount sends - the bridge reads
 * every named control (radios, checkboxes, a `<select>`, a `<textarea>`, a
 * text or hidden field) on each `input` and `change` and on each change to
 * the document, and posts the one-way `answers` message: how many named
 * questions there are (`of`), how many are answered (non-empty, or not
 * `required`), how many differ from the state the author wrote (`changed`:
 * `defaultChecked`, `defaultValue`, the `selected` option, a hidden field's
 * first value), and the answers themselves, which are only the shell's
 * draft. A pick sends nothing to the author: only a footer button does,
 * after it asks the bridge for a fresh reading (`collect`), and the host
 * bounds what it sends. The `form` message carries the shell's draft back
 * to every new document of the card, which the bridge reapplies by name
 * where the captain changed a pick, so a pick survives a revision that
 * keeps its question and a renamed question starts fresh. A question's
 * Something else row (`data-inf-write-in`, FI3-1002) is never an option
 * value: while it is picked the bridge shows a text field of its own under
 * it and reads the words as the answer's `written`. A question marked
 * `data-inf-options-only` has no row; the mark is for the card lint, and the
 * bridge draws nothing for it.
 */
import { FRAME_QUESTION_SCRIPT } from "./frameQuestionScript";
import { FRAME_TAG_SCRIPT } from "./frameTagScript";

export const FRAME_FORM_SCRIPT = `  function kindOf(control) {
    if (control.tagName === "SELECT") return "select";
    if (control.tagName === "TEXTAREA") return "text";
    var type = (control.getAttribute("type") || "text").toLowerCase();
    if (type === "radio" || type === "checkbox" || type === "hidden") return type;
    if (type === "submit" || type === "button" || type === "reset" || type === "image" || type === "file") return "";
    return "text";
  }
  function words(node) {
    return (node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500);
  }
  function labelOf(control) {
    var parts = [];
    for (var i = 0; control.labels && i < control.labels.length; i++) parts.push(words(control.labels[i]));
    return parts.join(" ").trim();
  }
  // A locked past card disables every control, so its own dressing asks
  // for the disabled ones too.
  function questions(withDisabled) {
    var list = [];
    var byName = {};
    var controls = document.querySelectorAll("input[name], select[name], textarea[name]");
    for (var i = 0; i < controls.length; i++) {
      var control = controls[i];
      var kind = kindOf(control);
      if (!kind || (control.disabled && !withDisabled) || !control.name) continue;
      if (kind === "hidden" && !form.first.has(control)) form.first.set(control, control.value);
      var group = byName[control.name];
      if (!group) {
        group = byName[control.name] = { name: control.name, controls: [], required: false };
        list.push(group);
      }
      group.controls.push(control);
      if (control.required) group.required = true;
    }
    for (var name in form.staged) {
      if (!byName[name]) {
        byName[name] = { name: name, controls: [], required: false };
        list.push(byName[name]);
      }
      byName[name].staged = true;
    }
    return list;
  }
  function recommended(control, fallback) {
    var owner = control.tagName === "OPTION" ? control.closest("select") : control;
    var marked = owner.tagName === "SELECT"
      ? owner.querySelector("option[data-inf-recommended]")
      : document.querySelector('input[name="' + CSS.escape(control.name) + '"][data-inf-recommended]');
    return marked ? control.hasAttribute("data-inf-recommended") : fallback;
  }
  // A question's Something else row (FI3-1002): the author writes it as one
  // more radio or checkbox of the question, or an <option> of its select,
  // marked data-inf-write-in. It is never an option value: once picked the
  // app opens a text field under it, and the words in it are the answer.
  function isWriteIn(control) {
    return control.hasAttribute("data-inf-write-in");
  }
  function rowPicked(row) {
    return row.tagName === "OPTION" ? row.selected : row.checked;
  }
  function writeInRows(group) {
    var rows = [];
    group.controls.forEach(function (control) {
      var kind = kindOf(control);
      if ((kind === "radio" || kind === "checkbox") && isWriteIn(control)) rows.push(control);
      else if (kind === "select") {
        for (var i = 0; i < control.options.length; i++) if (isWriteIn(control.options[i])) rows.push(control.options[i]);
      }
    });
    return rows;
  }
  function pickedWriteIn(group) {
    return writeInRows(group).find(rowPicked) || null;
  }
  function writtenOf(row) {
    var field = row && form.fields.get(row);
    return field && rowPicked(row) ? field.value.trim().slice(0, WRITTEN_MAX) : "";
  }
  // A skip's Default is what the card proposed, never the captain's answer.
  function hasAnswer(answer) {
    return !answer.skipped && (answer.values.length > 0 || answer.written !== undefined);
  }
  function focusUnpicked() {
    var group = questions().find(function (group) { return group.required && !hasAnswer(answerOf(group)); });
    if (!group) return;
    // A picked Something else with nothing written: its field is what waits.
    var field = form.fields.get(pickedWriteIn(group));
    var control = field && !field.hidden ? field : group.controls.find(function (control) { return !control.disabled && !boxless(control); });
    if (control) { control.focus(); control.scrollIntoView({ block: "center", behavior: "smooth" }); }
  }
${FRAME_QUESTION_SCRIPT}
  // A question that recommends rather than pre-picks: nothing is chosen
  // until the captain chooses, so any answer it has is the captain's pick.
  function tagged(group) {
    return group.controls.some(function (control) { return control.hasAttribute("data-inf-recommended") || (kindOf(control) === "select" && control.querySelector("option[data-inf-recommended]")); });
  }
  function answerOf(group) {
    if (group.staged) return { name: group.name, values: [form.staged[group.name]], changed: true, json: true };
    var values = [];
    var labels = [];
    var proposed = [];
    function pick(value, label) {
      if (value === "") return;
      values.push(value);
      labels.push(label);
    }
    group.controls.forEach(function (control) {
      var kind = kindOf(control);
      if (kind === "radio" || kind === "checkbox") {
        if (isWriteIn(control)) return;
        if (control.checked) pick(control.value, labelOf(control));
        if (recommended(control, control.defaultChecked) && control.value !== "") proposed.push(control.value);
      } else if (kind === "select") {
        var marked = false;
        for (var i = 0; i < control.options.length; i++) {
          var option = control.options[i];
          if (isWriteIn(option)) continue;
          if (option.selected) pick(option.value, words(option));
          if (recommended(option, option.defaultSelected)) {
            marked = true;
            if (option.value !== "") proposed.push(option.value);
          }
        }
        var first = control.options[0];
        if (!marked && !control.multiple && first && first.value !== "" && !isWriteIn(first)) proposed.push(first.value);
      } else {
        pick(control.value, "");
        var initial = kind === "hidden" ? form.first.get(control) : control.defaultValue;
        if (initial) proposed.push(initial);
      }
    });
    // The captain's own words are never what the author proposed.
    var written = writtenOf(pickedWriteIn(group));
    var changed = written !== "" || ((!tagged(group) || values.length > 0 || (form.touched[group.name] === true && group.controls.some(function (control) { return kindOf(control) === "checkbox"; }))) && JSON.stringify(values.slice().sort()) !== JSON.stringify(proposed.slice().sort()));
    var answer = { name: group.name, values: values, changed: changed };
    // A question the captain may skip and left untouched sends its Default
    // (INF-4425), marked as a skip: every reader words it from this fact.
    if (skipped(group)) {
      answer = { name: group.name, values: proposed.slice(), changed: false, skipped: true };
      labels = proposed.map(function (value) { return defaultLabel(group, value); });
    }
    if (labels.some(function (label) { return label !== ""; })) answer.labels = labels;
    if (written) answer.written = written;
    return answer;
  }
  function wording(text) {
    var whole = (text || "").replace(/\\s+/g, " ").trim();
    return { text: whole.slice(0, LABEL_MAX), cut: whole.length > LABEL_MAX };
  }
  // A node's own words: the text of a control it wraps - a select's
  // options, a textarea's default - is an answer, never the question.
  function spoken(node) {
    var copy = node.cloneNode(true);
    var inner = copy.querySelectorAll("select, textarea, script, style");
    for (var i = 0; i < inner.length; i++) inner[i].remove();
    return copy.textContent || "";
  }
  function byIds(ids) {
    var parts = [];
    (ids || "").split(/\\s+/).forEach(function (id) {
      var node = id ? document.getElementById(id) : null;
      if (node) parts.push(spoken(node));
    });
    return parts.join(" ");
  }
  function ownWording(node) {
    if (node.hasAttribute("aria-labelledby")) return { raw: byIds(node.getAttribute("aria-labelledby")), basis: "labelledby" };
    if (node.hasAttribute("aria-label")) return { raw: node.getAttribute("aria-label"), basis: "aria-label" };
    if (node.tagName === "FIELDSET") {
      for (var i = 0; i < node.children.length; i++) {
        if (node.children[i].tagName === "LEGEND") return { raw: spoken(node.children[i]), basis: "legend" };
      }
    }
    return null;
  }
  function holderOf(control) {
    for (var node = control.parentElement; node && node !== document.body; node = node.parentElement) {
      var role = node.getAttribute("role");
      if (node.tagName === "FIELDSET" || role === "group" || role === "radiogroup") return node;
    }
    return null;
  }
  function promptOf(controls, lone) {
    if (lone) {
      var own = ownWording(controls[0]);
      if (own && own.raw) return own;
      var bound = [];
      for (var i = 0; controls[0].labels && i < controls[0].labels.length; i++) bound.push(spoken(controls[0].labels[i]));
      if (bound.join("").trim()) return { raw: bound.join(" "), basis: "label" };
    }
    var holders = controls.map(holderOf);
    var holder = holders[0];
    if (holders.every(function (each) { return each === holder; })) {
      if (holder) return ownWording(holder) || { gap: "no-prompt" };
    } else if (holders.some(function (each) { return each; })) return { gap: "conflicting-prompt" };
    var first = controls.map(function (control) { return (control.getAttribute("aria-labelledby") || "").split(/\\s+/)[0]; });
    if (!lone && first[0] && first.every(function (id) { return id === first[0]; })) return { raw: byIds(first[0]), basis: "labelledby" };
    return { gap: "no-prompt" };
  }
  function boxless(node) {
    return node.hidden || node.getClientRects().length === 0;
  }
  function defineQuestion(group) {
    var gaps = [];
    function gap(name) { if (gaps.indexOf(name) < 0) gaps.push(name); }
    function label(text) {
      var read = wording(text);
      if (read.cut) gap("label-truncated");
      return read.text || null;
    }
    var definition = { name: group.name, kind: "opaque", control: "staged", prompt: null, promptBasis: null, options: [], defaultBasis: "none", required: group.required, gaps: gaps, complete: false };
    if (group.staged) {
      gap("opaque");
      return definition;
    }
    var all = [];
    var named = document.getElementsByName(group.name);
    for (var i = 0; i < named.length; i++) if (kindOf(named[i])) all.push(named[i]);
    var kinds = [];
    group.controls.forEach(function (control) {
      var kind = kindOf(control);
      if (kinds.indexOf(kind) < 0) kinds.push(kind);
    });
    var kind = kinds.length === 1 ? kinds[0] : "mixed";
    var first = group.controls[0];
    if (kind === "mixed") {
      gap("mixed-controls");
      definition.control = "mixed";
    } else if (kind === "hidden") {
      definition.control = "hidden";
      if (form.first.get(first)) definition.defaultBasis = "authored";
    } else if (kind === "radio" || kind === "checkbox") {
      definition.control = kind;
      definition.kind = kind === "radio" ? "single" : "multiple";
      all.forEach(function (control) {
        if (kindOf(control) !== kind) return;
        if (isWriteIn(control)) {
          definition.writeIn = true;
          return;
        }
        definition.options.push({ value: control.value, label: label(labelOf(control)), authoredDefault: recommended(control, control.defaultChecked), disabled: control.disabled, hidden: boxless(control) });
      });
      if (definition.options.some(function (option) { return option.authoredDefault; })) definition.defaultBasis = "authored";
    } else if (kind === "select") {
      definition.control = first.multiple ? "select-multiple" : "select";
      definition.kind = first.multiple ? "multiple" : "single";
      group.controls.forEach(function (control) {
        for (var i = 0; i < control.options.length; i++) {
          var option = control.options[i];
          if (isWriteIn(option)) {
            definition.writeIn = true;
            continue;
          }
          definition.options.push({ value: option.value, label: label(option.textContent), authoredDefault: recommended(option, option.defaultSelected), disabled: option.disabled, hidden: option.hidden });
        }
      });
      if (definition.options.some(function (option) { return option.authoredDefault; })) definition.defaultBasis = "authored";
      else if (!first.multiple && first.options[0] && first.options[0].value !== "") definition.defaultBasis = "implicit-first";
    } else {
      definition.control = first.tagName === "TEXTAREA" ? "textarea" : "text";
      definition.kind = "text";
      if (group.controls.some(function (control) { return control.defaultValue; })) definition.defaultBasis = "authored";
    }
    if (definition.kind === "opaque") {
      gap("opaque");
      return definition;
    }
    var values = definition.options.map(function (option) { return option.value; });
    if (values.some(function (value, index) { return values.indexOf(value) !== index; })) gap("duplicate-values");
    var lone = group.controls.length === 1 && (kind === "text" || kind === "select");
    var prompt = promptOf(group.controls, lone);
    if (prompt.gap || !wording(prompt.raw).text) gap(prompt.gap || "no-prompt");
    else {
      definition.prompt = label(prompt.raw);
      definition.promptBasis = prompt.basis;
    }
    definition.complete = gaps.length === 0;
    return definition;
  }
  function readForm(seq) {
    var answers = [];
    var answered = 0;
    var changed = 0;
    var picked = 0;
    var defaults = 0;
    var groups = questions();
    groups.forEach(function (group) {
      var answer = answerOf(group);
      answers.push(answer);
      if (answer.skipped) defaults += 1;
      if (!group.required || hasAnswer(answer)) answered += 1;
      if (answer.changed) changed += 1;
      // The captain's own answers, which a close would lose: a change from
      // the author's proposal, a pick where the author only recommended, or
      // words written under Something else. An untouched prefilled field or
      // authored default is not one.
      if (tagged(group) ? hasAnswer(answer) : answer.changed) picked += 1;
    });
    var message = { type: "answers", answered: answered, of: answers.length, changed: changed, picked: picked, defaults: defaults, answers: answers };
    var key = JSON.stringify(message);
    if (seq === undefined && key === form.last) return;
    form.last = key;
    if (seq !== undefined) {
      message.seq = seq;
      // What the questions offered rides only the reading a footer click
      // asked for, never a draft (docs/card-evidence.md).
      try {
        var defined = groups.map(defineQuestion);
        if (new TextEncoder().encode(JSON.stringify(defined)).byteLength > QUESTIONS_MAX_BYTES) message.questionsGap = "too-large";
        else message.questions = defined;
      } catch (error) {
        message.questionsGap = "invalid";
      }
    }
    post(message);
  }
  // The question the captain is typing in now: a text field of it, or its
  // Something else field, holds focus in a document that has it. A pick
  // under focus is no typing, and takes another window's change at once.
  function typingIn(group) {
    var focused = document.activeElement;
    if (!focused || !document.hasFocus()) return false;
    // A preview's setting has no control of its own: any field the preview
    // takes words in holds it while the captain types there.
    if (group.staged) return takesWords(focused);
    if (group.controls.indexOf(focused) >= 0) return kindOf(focused) === "text";
    return writeInRows(group).some(function (row) { return form.fields.get(row) === focused; });
  }
  function takesWords(element) {
    return element.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(element.tagName) && kindOf(element) === "text" && element.type !== "range" && element.type !== "color");
  }
  // Another window's change to a question being typed in waits, with the
  // question's answer it arrived over, until typing there stops; the
  // captain's own words since then keep it from showing.
  function settleWaiting() {
    var names = Object.keys(form.waiting);
    if (names.length === 0 || form.locked) return;
    var byName = {};
    questions().forEach(function (group) { byName[group.name] = group; });
    var due = [];
    names.forEach(function (name) {
      var group = byName[name];
      if (group && typingIn(group)) return;
      var waiting = form.waiting[name];
      delete form.waiting[name];
      if (group && JSON.stringify(answerOf(group)) === waiting.over) due.push(waiting.answer);
    });
    if (due.length > 0) fillForm(due, true);
  }
  // A draft by name: a new document's (\`live\` false), or another window's
  // change to the body on screen (\`live\` true), which waits on the
  // question being typed in and takes back a field emptied to its proposal.
  function fillForm(answers, live) {
    var byName = {};
    questions().forEach(function (group) { byName[group.name] = group; });
    var touched = [];
    var applied = [];
    answers.forEach(function (answer) {
      if (!answer || !Array.isArray(answer.values)) return;
      var group = byName[answer.name];
      if (answer.json) {
        // A preview's setting goes through the preview's own controls, by
        // the function it staged the setting with, as if the captain set
        // them; a preview that gave none keeps what it shows and sends.
        var apply = form.appliers[answer.name];
        if (!apply || typeof answer.values[0] !== "string") return;
        if (live) delete form.waiting[answer.name];
        if (live && group && typingIn(group)) {
          // Words the captain types in the preview after this arrived are
          // theirs, even where the preview stages them only later.
          form.waiting[answer.name] = { answer: answer, over: JSON.stringify(answerOf(group)), staged: true };
          return;
        }
        // What a press sends is only what the preview stages from it: one
        // that refuses or fails on the setting keeps its own.
        try {
          applied.push({ apply: apply, value: JSON.parse(answer.values[0]) });
        } catch (error) {}
        return;
      }
      if (!group || group.staged) return;
      if (live) delete form.waiting[answer.name];
      if (live && typingIn(group)) {
        form.waiting[answer.name] = { answer: answer, over: JSON.stringify(answerOf(group)) };
        return;
      }
      // A skip is the card's own proposal: a live form leaves the question
      // untouched, so it still shows and sends its Default; a past card
      // draws the Default the skip sent.
      if (answer.skipped && !form.locked) return;
      if (!live && !answer.changed && group.controls.every(function (control) { var kind = kindOf(control); return kind === "text" || kind === "hidden"; })) return;
      var values = answer.values.map(String);
      // A restored change the captain made is still the captain's: an
      // emptied checkbox question stays touched, so its default comes back
      // neither as a ring nor as what a skip sends.
      if (!answer.skipped && (answer.changed || values.length > 0)) form.touched[answer.name] = true;
      // Words written under Something else come back under the new body's
      // own Something else row; a body with none leaves them at its proposal.
      var written = typeof answer.written === "string" ? answer.written : "";
      var row = written ? writeInRows(group)[0] || null : null;
      if (written && !row && values.length === 0) return;
      var offered = group.controls.some(function (control) {
        var kind = kindOf(control);
        if (kind === "text" || kind === "hidden") return true;
        if (kind !== "select") return values.indexOf(control.value) >= 0;
        for (var i = 0; i < control.options.length; i++) {
          if (values.indexOf(control.options[i].value) >= 0) return true;
        }
        return false;
      });
      if (values.length > 0 && !offered) return;
      var next = 0;
      group.controls.forEach(function (control) {
        var kind = kindOf(control);
        if (kind === "radio" || kind === "checkbox") control.checked = isWriteIn(control) ? control === row : values.indexOf(control.value) >= 0;
        else if (kind === "select") {
          for (var i = 0; i < control.options.length; i++) {
            var option = control.options[i];
            option.selected = isWriteIn(option) ? option === row : values.indexOf(option.value) >= 0;
          }
        } else control.value = values[next++] || "";
        touched.push(control);
      });
      var field = row && writeInField(row);
      if (field) field.value = written;
    });
    form.filling = true;
    try {
      touched.forEach(function (control) {
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
      });
    } finally {
      form.filling = false;
    }
    form.applying = applied.length > 0;
    try {
      applied.forEach(function (setting) {
        try {
          setting.apply(setting.value);
        } catch (error) {}
      });
    } finally {
      form.applying = false;
    }
    if (applied.length > 0 && form.on) readForm();
  }
${FRAME_TAG_SCRIPT}
  // The field under a Something else row: the app's own, with no name, so
  // its words ride the row's question as "written" and never a question of
  // their own. One line that grows to three (the frame stylesheet).
  function writeInField(row) {
    var field = form.fields.get(row);
    if (field && field.isConnected) return field;
    var owner = row.tagName === "OPTION" ? row.closest("select") : row;
    if (!owner || !owner.name) return null;
    field = document.createElement("textarea");
    field.setAttribute("data-inf-write-in-field", owner === row ? "row" : "select");
    field.rows = 1;
    field.maxLength = WRITTEN_MAX;
    field.placeholder = "Say what you want instead";
    var named = [];
    var all = document.getElementsByName(owner.name);
    for (var i = 0; i < all.length; i++) if (kindOf(all[i])) named.push(all[i]);
    var asked = promptOf(named, owner !== row);
    var prompt = asked.gap ? "" : wording(asked.raw).text;
    field.setAttribute("aria-label", prompt ? "Your own answer to: " + prompt : "Your own answer");
    field.hidden = true;
    form.fields.set(row, field);
    var anchor = owner;
    if (owner === row) {
      var label = row.closest("label") || (row.labels && row.labels[row.labels.length - 1]);
      if (label && (label.contains(row) || row.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING)) anchor = label;
    } else {
      while (isSelectTag(anchor.nextElementSibling)) anchor = anchor.nextElementSibling;
    }
    anchor.after(field);
    return field;
  }
  // Each Something else row's field shows only while the row is picked, and
  // keeps its words while it hides: they are sent only with the row.
  function offerWriteIns() {
    document.querySelectorAll('input[data-inf-write-in]:is([type="radio"], [type="checkbox"]), select option[data-inf-write-in]').forEach(function (row) {
      var field = writeInField(row);
      if (!field) return;
      var shown = rowPicked(row);
      if (field.hidden === shown) field.hidden = !shown;
    });
  }
  // Picking Something else puts the captain in its field, ready to write. A
  // pick the bridge restored (a revision's draft) moves no focus.
  function focusWriteIn(event) {
    var target = event.target;
    if (form.filling || form.locked || !target || !target.hasAttribute) return;
    var row = target.tagName === "SELECT"
      ? Array.prototype.find.call(target.selectedOptions, isWriteIn)
      : isWriteIn(target) && target.checked ? target : null;
    var field = row && form.fields.get(row);
    if (field && !field.hidden) field.focus();
  }
  // A locked card answers nothing more, but its demo still plays: its Play
  // button is a viewer, not an answer.
  function lockForm() {
    document.querySelectorAll("input, select, textarea, button:not([data-inf-demo-play]), fieldset").forEach(function (control) {
      if (!control.disabled) control.disabled = true;
    });
  }
  function dressForm() {
    tagRecommendations();
    offerWriteIns();
  }
  function startForm() {
    dressForm();
    if (form.fill) fillForm(form.fill);
    form.fill = null;
    // A draft filled into a new document shows its rows' fields: no watch
    // heard that fill.
    offerWriteIns();
    if (form.locked) lockForm();
    if (!form.on) {
      form.on = true;
      var watch = function () { dressForm(); if (form.locked) lockForm(); readForm(); };
      // Whatever the captain changes in a question is theirs from then on.
      var touch = function (event) {
        var target = event.target;
        if (form.filling || form.locked || !target || !target.name || !kindOf(target)) return;
        form.touched[target.name] = true;
      };
      document.addEventListener("input", touch, true);
      // The captain's words in a preview's field outrank a setting waiting on them.
      document.addEventListener("input", function (event) {
        if (form.filling || form.applying || !event.target || !takesWords(event.target)) return;
        Object.keys(form.waiting).forEach(function (name) {
          if (form.waiting[name].staged) delete form.waiting[name];
        });
      }, true);
      document.addEventListener("change", touch, true);
      document.addEventListener("input", watch, true);
      document.addEventListener("change", watch, true);
      document.addEventListener("change", focusWriteIn);
      document.addEventListener("click", pickTradeoff);
      // Focus leaves on the next turn, once the next element holds it.
      document.addEventListener("focusout", function () { setTimeout(settleWaiting, 0); });
      window.addEventListener("blur", settleWaiting);
      new MutationObserver(watch).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["name", "value", "disabled", "required", "checked", "selected", "data-inf-recommended", "data-inf-current", "data-inf-write-in"]
      });
    }
    readForm();
  }`;
