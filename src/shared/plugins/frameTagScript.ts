import { AS_BUILT_WORDS, DEFAULT_WORDS } from "./bridge";

/**
 * Trusted bridge code that tags a card body's marked options - As built,
 * Recommended, and on a question the captain may skip its Default (INF-4425)
 * with the hollow ring a skip sends - spliced into `FRAME_FORM_SCRIPT`
 * (./frameFormScript.ts) where it reads the form's own helpers.
 */
export const FRAME_TAG_SCRIPT = `  // A question the captain may skip (INF-4425): not required, on a decision
  // that is not a preview, with an option its author marked. A skip sends
  // that option, so the app tags it Default rather than Recommended.
  function skippable(group) {
    return !form.preview && !group.required && !group.staged && tagged(group);
  }
  // Nothing picked or written in it, and never changed by the captain: a
  // checkbox question emptied by hand is touched, and sends none.
  function untouched(group) {
    if (form.touched[group.name] || pickedWriteIn(group)) return false;
    return !group.controls.some(function (control) {
      var kind = kindOf(control);
      if (kind === "radio" || kind === "checkbox") return control.checked;
      if (kind === "select") return Array.prototype.some.call(control.options, function (option) { return option.selected && option.value !== ""; });
      return false;
    });
  }
  function skipped(group) {
    return skippable(group) && untouched(group);
  }
  // The app's own lines under a select, As built first, then Recommended.
  var SELECT_TAGS = ["data-inf-as-built", "data-inf-recommendation"];
  function isSelectTag(element) {
    return element && SELECT_TAGS.some(function (attribute) { return element.hasAttribute(attribute); });
  }
  function tagSelect(select, mark, attribute, word) {
    var options = Array.from(select.options).filter(function (option) { return option.hasAttribute(mark); });
    var tag = null;
    var end = select;
    for (var next = select.nextElementSibling; isSelectTag(next); next = next.nextElementSibling) {
      if (next.hasAttribute(attribute)) tag = next;
      end = next;
    }
    if (!tag) {
      if (!options.length) return;
      tag = document.createElement("span");
      tag.setAttribute(attribute, "");
      (attribute === SELECT_TAGS[0] ? select : end).after(tag);
    }
    var text = options.length ? word + ": " + options.map(words).join(", ") : "";
    if (tag.textContent !== text) tag.textContent = text;
  }
  // Recommended is the author's pick; As built (data-inf-current) is what the
  // code does now. Both only tag: neither picks an option nor joins the
  // answer. On a question the captain may skip, the author's pick is its
  // Default (INF-4425): what a skip sends, drawn as a hollow ring while the
  // question is untouched. A past card shows the ring nowhere, and keeps its
  // tags when it is dressed again after its controls are locked.
  function tagRecommendations() {
    var groups = {};
    questions(form.locked).forEach(function (group) { groups[group.name] = group; });
    function label(control, mark, on) {
      Array.from(control.labels || []).forEach(function (owner) {
        if (on && !owner.hasAttribute(mark)) owner.setAttribute(mark, "");
        else if (!on && owner.hasAttribute(mark)) owner.removeAttribute(mark);
      });
    }
    document.querySelectorAll("input[data-inf-current]:is([type=radio], [type=checkbox])").forEach(function (control) {
      label(control, "data-inf-current-label", true);
    });
    document.querySelectorAll("input:is([type=radio], [type=checkbox])").forEach(function (control) {
      var marked = control.hasAttribute("data-inf-recommended");
      var group = groups[control.name];
      var asDefault = marked && Boolean(group) && skippable(group);
      label(control, "data-inf-recommended-label", marked && !asDefault);
      label(control, "data-inf-default-label", asDefault);
      var ring = asDefault && !form.locked && untouched(group);
      if (ring !== control.hasAttribute("data-inf-default-ring")) control.toggleAttribute("data-inf-default-ring", ring);
    });
    document.querySelectorAll("select").forEach(function (select) {
      var group = groups[select.name];
      tagSelect(select, "data-inf-current", "data-inf-as-built", ${JSON.stringify(AS_BUILT_WORDS)});
      tagSelect(select, "data-inf-recommended", "data-inf-recommendation", group && skippable(group) ? ${JSON.stringify(DEFAULT_WORDS)} : "Recommended");
    });
  }
  // The words of the option a skip sends, as a pick of it would read.
  function defaultLabel(group, value) {
    for (var i = 0; i < group.controls.length; i++) {
      var control = group.controls[i];
      var kind = kindOf(control);
      if ((kind === "radio" || kind === "checkbox") && control.value === value) return labelOf(control);
      if (kind === "select") {
        for (var j = 0; j < control.options.length; j++) if (control.options[j].value === value) return words(control.options[j]);
      }
    }
    return "";
  }`;
