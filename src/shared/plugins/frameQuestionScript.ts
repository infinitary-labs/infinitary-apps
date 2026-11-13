/**
 * Trusted bridge code for moving between a card body's questions
 * (docs/keyboard.md, "Moving between a card's questions"), spliced into
 * `FRAME_BRIDGE_SCRIPT` where it reads the form's own helpers.
 */
export const FRAME_QUESTION_SCRIPT = `  // Moving between the body's questions (docs/keyboard.md, "Moving between a
  // card's questions"): each question with a control a person can reach, in
  // the order the body asks them. A preview's staged settings have none.
  function reachable(control) {
    return !control.disabled && kindOf(control) !== "hidden" && !boxless(control);
  }
  function askable() {
    return questions().filter(function (group) { return group.controls.some(reachable); });
  }
  // The Something else row whose field this is, and its question.
  function rowOfField(field) {
    var found = null;
    questions().forEach(function (group) {
      writeInRows(group).forEach(function (row) { if (form.fields.get(row) === field) found = { group: group, row: row }; });
    });
    return found;
  }
  function questionAt(element) {
    if (!element || element.nodeType !== 1 || !element.hasAttribute) return null;
    if (element.hasAttribute("data-inf-write-in-field")) {
      var owned = rowOfField(element);
      return owned ? owned.group.name : null;
    }
    var kind = element.name ? kindOf(element) : "";
    return kind && kind !== "hidden" ? element.name : null;
  }
  // A step lands on the picked option, else the Recommended one, else the
  // question's first control; a picked Something else lands on its row.
  // Landing picks nothing.
  function landing(group) {
    var reach = group.controls.filter(reachable);
    var picked = reach.find(function (control) {
      var kind = kindOf(control);
      return (kind === "radio" || kind === "checkbox") && control.checked;
    });
    return picked || reach.find(function (control) { return control.hasAttribute("data-inf-recommended"); }) || reach[0];
  }
  function stepQuestion(step, unpicked, wrap, restart, keyboard, seq) {
    var list = askable();
    var answer = { type: "questioned" };
    if (seq) answer.seq = seq;
    if (!list.length) { post(answer); return; }
    var name = restart ? null : questionAt(document.activeElement) || form.current;
    var at = -1;
    for (var i = 0; i < list.length; i++) if (list[i].name === name) at = i;
    var to;
    if (unpicked) {
      to = 0;
      for (var n = 1; n <= list.length; n++) {
        var index = (at + n + list.length) % list.length;
        if (!hasAnswer(answerOf(list[index]))) { to = index; break; }
      }
    } else if (at < 0) to = step > 0 ? 0 : list.length - 1;
    else {
      to = at + step;
      if (to >= list.length) {
        if (!wrap) { answer.end = true; post(answer); return; }
        to = 0;
      }
      if (to < 0) to = wrap ? list.length - 1 : 0;
    }
    var group = list[to];
    form.current = group.name;
    var control = landing(group);
    var box = holderOf(control) || control;
    for (var ancestor = box.parentElement; ancestor; ancestor = ancestor.parentElement) if (ancestor.tagName === "DETAILS") ancestor.open = true;
    if (keyboard) control.focus({ preventScroll: true });
    resize();
    requestAnimationFrame(function () {
      document.querySelectorAll("[data-inf-revision-highlight]").forEach(function (el) { el.removeAttribute("data-inf-revision-highlight"); });
      box.setAttribute("data-inf-revision-highlight", "");
      setTimeout(function () { box.removeAttribute("data-inf-revision-highlight"); }, 1000);
      var rect = box.getBoundingClientRect();
      answer.top = Math.max(0, rect.top + window.scrollY);
      answer.height = rect.height;
      post(answer);
    });
  }
  // A question's key the phone's web view did not deliver: pressed on the
  // focused question control, where the keys below take it.
  function pressQuestionKey(key, shift) {
    if (typeof key !== "string" || !/^([1-9]|Enter)$/.test(key) || !document.hasFocus()) return;
    var target = document.activeElement;
    if (!questionAt(target) || target.hasAttribute("data-inf-write-in-field")) return;
    var init = { key: key, code: key === "Enter" ? "Enter" : "Digit" + key, shiftKey: shift, bubbles: true, cancelable: true, composed: true };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }
  // The question last focused or touched is the one a step starts from.
  ["focusin", "change"].forEach(function (type) {
    document.addEventListener(type, function (event) {
      var name = questionAt(event.target);
      if (name) form.current = name;
    }, true);
  });
  // After the body's own handlers, on a question's control: Enter takes the
  // option it rests on and goes to the next question, Shift+Enter goes back
  // and takes nothing, 1 to 9 take that option, and the arrows move between
  // checkboxes without ticking them. A multi-line field keeps Enter for a
  // new line; Up from a Something else field's first line goes to its row.
  document.addEventListener("keydown", function (event) {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || form.locked) return;
    var target = event.target;
    if (!target || target.nodeType !== 1 || !target.hasAttribute) return;
    if (target.hasAttribute("data-inf-write-in-field")) {
      if (event.key !== "ArrowUp" || event.shiftKey || target.selectionStart !== 0 || target.selectionEnd !== 0) return;
      var owned = rowOfField(target);
      if (owned && owned.row.tagName !== "OPTION" && reachable(owned.row)) { event.preventDefault(); owned.row.focus(); }
      return;
    }
    var kind = target.name ? kindOf(target) : "";
    if (!kind || kind === "hidden" || target.tagName === "TEXTAREA") return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.repeat) return;
      if (!event.shiftKey && kind === "radio" && !target.checked) {
        target.click();
        // A Something else row waits for its words in the field it opened.
        if (isWriteIn(target)) return;
      }
      stepQuestion(event.shiftKey ? -1 : 1, false, false, false, true, 0);
      return;
    }
    if (event.shiftKey || (kind !== "radio" && kind !== "checkbox")) return;
    var options = [];
    var all = document.getElementsByName(target.name);
    for (var i = 0; i < all.length; i++) if (kindOf(all[i]) === kind && reachable(all[i])) options.push(all[i]);
    if (event.key.length === 1 && event.key >= "1" && event.key <= "9") {
      var option = options[Number(event.key) - 1];
      if (!option) return;
      event.preventDefault();
      if (event.repeat) return;
      option.focus();
      if (kind === "checkbox" || !option.checked) option.click();
      return;
    }
    var moves = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    if (kind !== "checkbox" || !Object.prototype.hasOwnProperty.call(moves, event.key)) return;
    var from = options.indexOf(target);
    if (from < 0 || options.length < 2) return;
    event.preventDefault();
    options[(from + moves[event.key] + options.length) % options.length].focus();
  });`;
