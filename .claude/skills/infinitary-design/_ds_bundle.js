/* @ds-bundle: {"format":4,"namespace":"InfinitaryDesignSystem_94f559","components":[{"name":"CardStack","sourcePath":"components/cards/CardStack.jsx"},{"name":"ResponseCard","sourcePath":"components/cards/ResponseCard.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"Input","sourcePath":"components/core/Input.jsx"},{"name":"KeyCap","sourcePath":"components/core/KeyCap.jsx"},{"name":"Switch","sourcePath":"components/core/Switch.jsx"},{"name":"MachineRow","sourcePath":"components/machines/MachineRow.jsx"},{"name":"ActivityFeed","sourcePath":"components/mate/ActivityFeed.jsx"},{"name":"CrewStrip","sourcePath":"components/mate/CrewStrip.jsx"},{"name":"Crewmate","sourcePath":"components/mate/Crewmate.jsx"},{"name":"Firstmate","sourcePath":"components/mate/Firstmate.jsx"},{"name":"BucketBadge","sourcePath":"components/quota/SlotBadge.jsx"},{"name":"QuotaMeter","sourcePath":"components/quota/QuotaMeter.jsx"},{"name":"SubscriptionCard","sourcePath":"components/quota/SubscriptionCard.jsx"},{"name":"VoiceInput","sourcePath":"components/voice/VoiceInput.jsx"}],"sourceHashes":{"components/cards/CardStack.jsx":"727ee6d5d3e9","components/cards/ResponseCard.jsx":"e38abedb69f2","components/core/Badge.jsx":"94770091e424","components/core/Button.jsx":"f38e7435ddd5","components/core/IconButton.jsx":"ff6e8ae11d30","components/core/Input.jsx":"b5c30fb16a0f","components/core/KeyCap.jsx":"2feb5a4a7469","components/core/Switch.jsx":"46f714a47c9f","components/machines/MachineRow.jsx":"e4e936a9ae66","components/mate/ActivityFeed.jsx":"8c9d561c1e37","components/mate/CrewStrip.jsx":"8a08a70bc112","components/mate/Crewmate.jsx":"f22f55d976b6","components/mate/Firstmate.jsx":"cc986532e821","components/quota/SlotBadge.jsx":"d523e6f2d1e2","components/quota/QuotaMeter.jsx":"4e8091644caa","components/quota/SubscriptionCard.jsx":"55d96204ab45","components/voice/VoiceInput.jsx":"cb756e541bb8","ui_kits/firstmate/AppShell.jsx":"029b69688f5f","ui_kits/firstmate/SettingsScreen.jsx":"7eb235ce1808"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.InfinitaryDesignSystem_94f559 = window.InfinitaryDesignSystem_94f559 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Badge.jsx
try { (() => {
const badgeTones = {
  neutral: {
    color: "var(--fg-2)",
    background: "var(--bg-3)",
    border: "transparent"
  },
  accent: {
    color: "var(--accent)",
    background: "var(--accent-dim)",
    border: "transparent"
  },
  ok: {
    color: "var(--ok)",
    background: "var(--ok-dim)",
    border: "transparent"
  },
  warn: {
    color: "var(--warn)",
    background: "var(--warn-dim)",
    border: "transparent"
  },
  danger: {
    color: "var(--danger)",
    background: "var(--danger-dim)",
    border: "transparent"
  },
  outline: {
    color: "var(--fg-2)",
    background: "transparent",
    border: "var(--line-1)"
  }
};
function Badge({
  tone = "neutral",
  mono,
  dot,
  children,
  style
}) {
  const t = badgeTones[tone];
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      fontFamily: mono ? "var(--font-mono)" : "var(--font-ui)",
      fontSize: "var(--text-xs)",
      fontWeight: 500,
      letterSpacing: "var(--tracking-label)",
      textTransform: "uppercase",
      color: t.color,
      background: t.background,
      border: "1px solid " + t.border,
      borderRadius: "var(--radius-s)",
      padding: "3px 8px",
      lineHeight: 1.4,
      ...style
    }
  }, dot && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 5,
      height: 5,
      borderRadius: "50%",
      background: "currentColor"
    }
  }), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/cards/ResponseCard.jsx
try { (() => {
const cardKinds = {
  decision: {
    label: "Decision",
    tone: "accent"
  },
  result: {
    label: "Done",
    tone: "ok"
  },
  prototype: {
    label: "Prototype",
    tone: "accent"
  },
  info: {
    label: "Note",
    tone: "neutral"
  },
  error: {
    label: "Attention",
    tone: "danger"
  },
  working: {
    label: "Working",
    tone: "accent"
  }
};
const closeIco = /*#__PURE__*/React.createElement("svg", {
  width: "16",
  height: "16",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "1.5",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": "true"
}, /*#__PURE__*/React.createElement("path", {
  d: "M18 6 6 18M6 6l12 12"
}));
function ResponseCard({
  kind = "info",
  title,
  meta,
  actions,
  onClose,
  children,
  width = 560,
  minHeight = 340,
  style
}) {
  const k = cardKinds[kind] || cardKinds.info;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width,
      minHeight,
      boxSizing: "border-box",
      display: "flex",
      flexDirection: "column",
      background: "var(--acrylic-bg)",
      backdropFilter: "var(--acrylic-blur)",
      WebkitBackdropFilter: "var(--acrylic-blur)",
      border: "1px solid var(--acrylic-border)",
      borderRadius: "var(--radius-l)",
      boxShadow: "var(--acrylic-shadow)",
      overflow: "hidden",
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "14px 12px 0 20px"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    tone: k.tone,
    dot: true,
    style: {
      flexShrink: 0
    }
  }, k.label), meta && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-xs)",
      color: "var(--fg-3)",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      minWidth: 0,
      flex: 1
    }
  }, meta), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    label: "Close",
    onClick: onClose,
    style: {
      marginLeft: "auto",
      flexShrink: 0
    }
  }, closeIco)), title && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "10px 20px 0",
      fontSize: "var(--text-lg)",
      fontWeight: 500,
      letterSpacing: "var(--tracking-display)",
      color: "var(--fg-1)",
      lineHeight: "var(--leading-tight)"
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      padding: "12px 20px 18px",
      fontSize: "var(--text-base)",
      color: "var(--fg-2)",
      lineHeight: "var(--leading-body)"
    }
  }, children), actions && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      justifyContent: "flex-end",
      padding: "0 16px 16px"
    }
  }, actions));
}
Object.assign(__ds_scope, { ResponseCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/cards/ResponseCard.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const base = {
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-base)",
  fontWeight: 500,
  borderRadius: "var(--radius-m)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  border: "1px solid transparent",
  transition: "background var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out),opacity var(--dur-fast) var(--ease-out)",
  lineHeight: 1
};
const variants = {
  primary: {
    background: "var(--accent)",
    color: "#05070d",
    borderColor: "transparent"
  },
  secondary: {
    background: "transparent",
    color: "var(--fg-1)",
    borderColor: "var(--line-2)"
  },
  ghost: {
    background: "transparent",
    color: "var(--fg-2)",
    borderColor: "transparent"
  },
  danger: {
    background: "transparent",
    color: "var(--danger)",
    borderColor: "var(--danger)"
  }
};
const sizes = {
  sm: {
    padding: "6px 12px",
    fontSize: "var(--text-sm)"
  },
  md: {
    padding: "9px 16px"
  },
  lg: {
    padding: "12px 22px",
    fontSize: "var(--text-md)"
  }
};
function Button({
  variant = "primary",
  size = "md",
  disabled,
  icon,
  children,
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const hoverStyle = hover && !disabled ? variant === "primary" ? {
    background: "var(--accent-strong)"
  } : variant === "danger" ? {
    background: "var(--danger-dim)"
  } : {
    background: "var(--bg-3)",
    color: "var(--fg-1)"
  } : {};
  return /*#__PURE__*/React.createElement("button", _extends({
    disabled: disabled,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      ...base,
      ...variants[variant],
      ...sizes[size],
      ...(disabled ? {
        opacity: 0.4,
        cursor: "default"
      } : {}),
      ...hoverStyle,
      ...style
    }
  }, rest), icon, children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function IconButton({
  label,
  size = 32,
  tone = "neutral",
  disabled,
  children,
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const tones = {
    neutral: {
      color: "var(--fg-2)"
    },
    accent: {
      color: "var(--accent)"
    },
    danger: {
      color: "var(--danger)"
    },
    ok: {
      color: "var(--ok)"
    }
  };
  return /*#__PURE__*/React.createElement("button", _extends({
    "aria-label": label,
    title: label,
    disabled: disabled,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      width: size,
      height: size,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: "var(--radius-pill)",
      border: "1px solid transparent",
      background: hover && !disabled ? "var(--bg-3)" : "transparent",
      cursor: disabled ? "default" : "pointer",
      opacity: disabled ? 0.4 : 1,
      transition: "background var(--dur-fast) var(--ease-out)",
      ...tones[tone],
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/cards/CardStack.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const csIcoS = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round"
};
function CardStack({
  index = 0,
  count = 1,
  onPrev,
  onNext,
  width = 560,
  children,
  peekStyle,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      width,
      ...style
    }
  }, count > 2 && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      left: 14,
      right: 14,
      top: -14,
      height: 14,
      background: "var(--acrylic-bg)",
      backdropFilter: "var(--acrylic-blur)",
      WebkitBackdropFilter: "var(--acrylic-blur)",
      border: "1px solid var(--acrylic-border)",
      borderBottom: "none",
      borderRadius: "var(--radius-l) var(--radius-l) 0 0",
      ...peekStyle,
      opacity: 0.35
    }
  }), count > 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      left: 7,
      right: 7,
      top: -7,
      height: 14,
      background: "var(--acrylic-bg)",
      backdropFilter: "var(--acrylic-blur)",
      WebkitBackdropFilter: "var(--acrylic-blur)",
      border: "1px solid var(--acrylic-border)",
      borderBottom: "none",
      borderRadius: "var(--radius-l) var(--radius-l) 0 0",
      ...peekStyle,
      opacity: 0.65
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    }
  }, children), count > 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    label: "Previous card",
    size: 28,
    onClick: onPrev,
    disabled: index <= 0
  }, /*#__PURE__*/React.createElement("svg", _extends({
    width: "14",
    height: "14",
    viewBox: "0 0 24 24"
  }, csIcoS), /*#__PURE__*/React.createElement("path", {
    d: "m15 18-6-6 6-6"
  }))), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-xs)",
      color: "var(--fg-3)"
    }
  }, index + 1, " / ", count), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    label: "Next card",
    size: 28,
    onClick: onNext,
    disabled: index >= count - 1
  }, /*#__PURE__*/React.createElement("svg", _extends({
    width: "14",
    height: "14",
    viewBox: "0 0 24 24"
  }, csIcoS), /*#__PURE__*/React.createElement("path", {
    d: "m9 18 6-6-6-6"
  })))));
}
Object.assign(__ds_scope, { CardStack });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/cards/CardStack.jsx", error: String((e && e.message) || e) }); }

// components/core/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Input({
  placeholder,
  value,
  onChange,
  mono,
  size = "md",
  style,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const pad = size === "lg" ? "14px 20px" : "9px 14px";
  return /*#__PURE__*/React.createElement("input", _extends({
    placeholder: placeholder,
    value: value,
    onChange: onChange,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
      fontFamily: mono ? "var(--font-mono)" : "var(--font-ui)",
      fontSize: size === "lg" ? "var(--text-md)" : "var(--text-base)",
      color: "var(--fg-1)",
      background: "var(--surface-input)",
      border: "1px solid " + (focus ? "var(--line-2)" : "var(--line-1)"),
      borderRadius: "var(--radius-m)",
      padding: pad,
      outline: "none",
      boxShadow: focus ? "var(--focus-ring)" : "none",
      transition: "border-color var(--dur-fast) var(--ease-out),box-shadow var(--dur-fast) var(--ease-out)",
      width: "100%",
      boxSizing: "border-box",
      ...style
    }
  }, rest));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Input.jsx", error: String((e && e.message) || e) }); }

// components/core/KeyCap.jsx
try { (() => {
function KeyCap({
  children
}) {
  const kbd = {
    fontSize: "var(--text-sm)",
    padding: "2px 7px",
    minWidth: 18
  };
  return /*#__PURE__*/React.createElement("kbd", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "var(--font-mono)",
      fontWeight: 500,
      color: "var(--fg-2)",
      background: "var(--bg-3)",
      border: "1px solid var(--line-1)",
      borderBottomWidth: 2,
      borderRadius: "var(--radius-s)",
      lineHeight: 1.5,
      ...kbd
    }
  }, children);
}
Object.assign(__ds_scope, { KeyCap });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/KeyCap.jsx", error: String((e && e.message) || e) }); }

// components/core/Switch.jsx
try { (() => {
function Switch({
  checked,
  onChange,
  label,
  disabled
}) {
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 10,
      cursor: disabled ? "default" : "pointer",
      opacity: disabled ? 0.4 : 1
    }
  }, /*#__PURE__*/React.createElement("span", {
    onClick: () => !disabled && onChange && onChange(!checked),
    role: "switch",
    "aria-checked": checked,
    style: {
      width: 36,
      height: 20,
      borderRadius: "var(--radius-pill)",
      background: checked ? "var(--accent)" : "var(--bg-3)",
      border: "1px solid " + (checked ? "transparent" : "var(--line-1)"),
      position: "relative",
      transition: "background var(--dur-med) var(--ease-out)",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: "absolute",
      top: 2,
      left: checked ? 17 : 2,
      width: 14,
      height: 14,
      borderRadius: "50%",
      background: checked ? "#05070d" : "var(--fg-2)",
      transition: "left var(--dur-med) var(--ease-out),background var(--dur-med) var(--ease-out)"
    }
  })), label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-base)",
      color: "var(--fg-1)"
    }
  }, label));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Switch.jsx", error: String((e && e.message) || e) }); }

// components/machines/MachineRow.jsx
try { (() => {
const DOT = { ok: "var(--ok)", warn: "var(--warn)", idle: "var(--idle)" };
function MachineRow({ name, detail, summary, state, tone = "ok", busy = false, action, style }) {
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 14, padding: "14px 18px", ...style } }, /* @__PURE__ */ React.createElement("span", { style: { width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: DOT[tone] || DOT.idle, boxShadow: tone === "ok" ? "0 0 8px var(--ok)" : "none" } }), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: "var(--text-base)", fontWeight: 500, color: "var(--fg-1)" } }, name), detail && /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--fg-3)" } }, detail), summary && /* @__PURE__ */ React.createElement("span", { style: { fontSize: "var(--text-sm)", color: "var(--fg-2)" } }, summary)), state && /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", whiteSpace: "nowrap", color: tone === "warn" ? "var(--warn)" : busy ? "var(--accent)" : "var(--fg-3)" } }, state), action);
}
Object.assign(__ds_scope, { MachineRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/machines/MachineRow.jsx", error: String((e && e.message) || e) }); }

// components/mate/ActivityFeed.jsx
try { (() => {
// Quiet crewmate event log: chromeless thread — a 1px rail ties events together.
// Rows fade with age; LAST line is the most recent. Timestamps are hh:mm 24h local.
// Home sizes the column to 33vh; extra rows scroll. No default row cap.
// Overflow: thin left-edge thumb on the rail (scroller is mirrored) + top dissolve.
const feedDot = {
  spawn: "var(--accent)",
  report: "var(--fg-2)",
  done: "var(--idle)"
};
function fmtTime(d) {
  const t = d instanceof Date ? d : new Date(d);
  return String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0");
}
function ActivityFeed({
  events = [],
  max,
  style
}) {
  const shown = max == null ? events : events.slice(-max); // oldest first, newest last
  if (!shown.length) return null;
  return /*#__PURE__*/React.createElement("div", {
    "data-activity-feed": "",
    style: {
      position: "relative",
      display: "flex",
      flexDirection: "column",
      minHeight: 0,
      overflow: "hidden",
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    "data-activity-feed-scroller": "",
    style: {
      display: "flex",
      flexDirection: "column",
      overflowY: "auto",
      overflowX: "hidden",
      minHeight: 0,
      flex: 1,
      transform: "scaleX(-1)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "auto",
      display: "flex",
      flexDirection: "column",
      gap: 7,
      paddingLeft: 14,
      borderLeft: "1px solid var(--line-1)",
      marginLeft: 2,
      transform: "scaleX(-1)"
    }
  }, shown.map((e, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      opacity: 0.3 + 0.7 * (shown.length === 1 ? 1 : i / (shown.length - 1)),
      transition: "opacity 0.3s"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 5,
      height: 5,
      borderRadius: "50%",
      background: feedDot[e.kind] || "var(--fg-3)",
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-xs)",
      color: "var(--fg-3)",
      width: 38,
      flexShrink: 0
    }
  }, fmtTime(e.time)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-sm)",
      color: "var(--fg-2)",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, e.text))))));
}
Object.assign(__ds_scope, { ActivityFeed });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/mate/ActivityFeed.jsx", error: String((e && e.message) || e) }); }

// components/mate/Crewmate.jsx
try { (() => {
// A crewmate: 3D wireframe tetrahedron — the simplest solid, clearly subordinate to the 4D Firstmate.
// Color says the same thing the Firstmate and the now panel say: ember (--wire-hot) while working, ice cyan (--wire-accent) while idle.
// Idle recedes by alpha and a slower spin, never by a second hue.
const s3 = 1 / Math.sqrt(3);
const CM_V = [[s3, s3, s3], [s3, -s3, -s3], [-s3, s3, -s3], [-s3, -s3, s3]];
const CM_E = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
function Crewmate({
  status = "idle",
  size = 28,
  style
}) {
  const ref = React.useRef(null);
  const statusRef = React.useRef(status);
  statusRef.current = status;
  React.useEffect(() => {
    const canvas = ref.current,
      ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    let hot = "#ffa257",
      accent = "#7fdcff",
      boost = 1,
      lastRead = 0;
    let raf,
      a = Math.random() * 6,
      last = performance.now(),
      speed = 0.1;
    function frame(now) {
      if (now - lastRead > 400) {
        // live theme switches re-paint
        const cs = getComputedStyle(canvas);
        hot = (cs.getPropertyValue("--wire-hot") || cs.getPropertyValue("--hot") || hot).trim();
        accent = (cs.getPropertyValue("--wire-accent") || cs.getPropertyValue("--accent") || accent).trim();
        boost = parseFloat(cs.getPropertyValue("--wire-boost")) || 1;
        lastRead = now;
      }
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const working = statusRef.current === "working";
      speed += ((working ? 1.3 : 0.3) - speed) * Math.min(dt * 3, 1); // idle keeps a slow visible spin
      a += speed * dt;
      const c = size / 2,
        R = size * 0.4,
        color = working ? hot : accent; // ember while working, cyan while idle
      const ca = Math.cos(a),
        sa = Math.sin(a),
        cb = Math.cos(a * 0.6),
        sb = Math.sin(a * 0.6);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const pts = CM_V.map(([x, y, z]) => {
        const x1 = x * ca - z * sa,
          z1 = x * sa + z * ca;
        const y1 = y * cb - z1 * sb,
          z2 = y * sb + z1 * cb;
        const k = 3 / (3 - z2);
        return [c + x1 * k * R, c + y1 * k * R, k];
      });
      ctx.lineWidth = 1.4;
      for (const [p, q] of CM_E) {
        const P = pts[p],
          Q = pts[q];
        ctx.strokeStyle = color;
        ctx.globalAlpha = Math.min(1, Math.max(0.35, Math.min(0.9, 0.4 + ((P[2] + Q[2]) / 2 - 0.85) * 0.9)) * (working ? 1 : 0.6) * boost);
        ctx.beginPath();
        ctx.moveTo(P[0], P[1]);
        ctx.lineTo(Q[0], Q[1]);
        ctx.stroke();
      }
      ctx.fillStyle = color;
      for (const P of pts) {
        ctx.globalAlpha = Math.min(1, Math.max(0.5, Math.min(1, 0.5 + (P[2] - 0.85) * 0.8)) * (working ? 1 : 0.6) * boost);
        ctx.beginPath();
        ctx.arc(P[0], P[1], 1.2 * (size / 28), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size]);
  return /*#__PURE__*/React.createElement("canvas", {
    ref: ref,
    "aria-label": "Crewmate — " + status,
    style: {
      width: size,
      height: size,
      display: "block",
      ...style
    }
  });
}
Object.assign(__ds_scope, { Crewmate });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/mate/Crewmate.jsx", error: String((e && e.message) || e) }); }

// components/mate/CrewStrip.jsx
try { (() => {
// Quiet crew overview: no chrome at rest; hover reveals the pill (it's interactive — a detail sheet pops above later).
// Zero counts are omitted entirely; each nonzero label is prefixed by ONE representative crewmate.
function CrewStrip({
  working = 0,
  idle = 0,
  style
}) {
  const [hover, setHover] = React.useState(false);
  const seg = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8
  };
  const label = {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    color: "var(--fg-2)",
    whiteSpace: "nowrap"
  };
  if (!working && !idle) return null;
  return /*#__PURE__*/React.createElement("div", {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 12,
      padding: "6px 14px",
      borderRadius: "var(--radius-pill)",
      border: "1px solid " + (hover ? "var(--line-1)" : "transparent"),
      background: hover ? "var(--bg-1)" : "transparent",
      cursor: "pointer",
      transition: "background var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out)",
      ...style
    }
  }, working > 0 && /*#__PURE__*/React.createElement("span", {
    style: seg
  }, /*#__PURE__*/React.createElement(__ds_scope.Crewmate, {
    status: "working",
    size: 22
  }), /*#__PURE__*/React.createElement("span", {
    style: label
  }, working, " working")), working > 0 && idle > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--fg-3)"
    }
  }, "\xB7"), idle > 0 && /*#__PURE__*/React.createElement("span", {
    style: seg
  }, /*#__PURE__*/React.createElement(__ds_scope.Crewmate, {
    status: "idle",
    size: 22
  }), /*#__PURE__*/React.createElement("span", {
    style: label
  }, idle, " idle")));
}
Object.assign(__ds_scope, { CrewStrip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/mate/CrewStrip.jsx", error: String((e && e.message) || e) }); }

// components/mate/Firstmate.jsx
try { (() => {
// The Firstmate: a 4D tesseract projection of lines and dots. Animation reflects state.
// idle = near-still drift · listening = rotation freezes, structure breathes with the voice · working = fast double rotation + shimmer + pulsing nodes
const FM_STATES = {
  idle: {
    sa: 0.05,
    sb: 0.03,
    pulse: 0.05,
    glow: 0.35,
    shimmer: 0,
    breath: 0,
    flat: 0,
    heat: 0
  },
  listening: {
    sa: 0.015,
    sb: 0.01,
    pulse: 0.5,
    glow: 1,
    shimmer: 0,
    breath: 0.09,
    flat: 1,
    heat: 0
  },
  working: {
    sa: 1.15,
    sb: 0.78,
    pulse: 0.9,
    glow: 1,
    shimmer: 0.5,
    breath: 0,
    flat: 0,
    heat: 1
  }
};
FM_STATES.thinking = FM_STATES.working; // legacy alias — thinking and working are one state
function fmRgba(c, a) {
  c = c.trim();
  if (c[0] === "#") {
    const n = parseInt(c.slice(1), 16);
    return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + a + ")";
  }
  if (c.indexOf("rgb(") === 0) return c.replace("rgb(", "rgba(").replace(")", "," + a + ")");
  return c;
}
function fmRgb(c) {
  c = c.trim();
  if (c[0] === "#") {
    const n = parseInt(c.slice(1), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  const m = c.match(/[\d.]+/g);
  return m ? [+m[0], +m[1], +m[2]] : [127, 220, 255];
}
function fmMix(A, B, t) {
  return "rgb(" + Math.round(A[0] + (B[0] - A[0]) * t) + "," + Math.round(A[1] + (B[1] - A[1]) * t) + "," + Math.round(A[2] + (B[2] - A[2]) * t) + ")";
}
function tesseract() {
  const v = [];
  for (let i = 0; i < 16; i++) v.push([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1, i & 8 ? 1 : -1]);
  const e = [];
  for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) {
    let d = 0;
    for (let k = 0; k < 4; k++) if (v[i][k] !== v[j][k]) d++;
    if (d === 1) e.push([i, j]);
  }
  return {
    v,
    e
  };
}
const {
  v: FM_V,
  e: FM_E
} = tesseract();
// Listening form (TARS-style shapeshift): the 16 vertices reassemble into two concentric hexagons + an inner square — all three are true cycles of the tesseract graph, so the wires simply glide into rings.
const FM_RINGS = [[0, 1, 5, 4, 12, 8], [9, 11, 10, 14, 15, 13], [2, 3, 7, 6]];
const FM_FLAT = new Array(16);
FM_RINGS.forEach((cyc, ri) => cyc.forEach((v, k) => FM_FLAT[v] = {
  ri,
  k,
  n: cyc.length
}));
const FM_RING_R = [1, 0.62, 0.3],
  FM_RING_DIR = [1, -1, 1.6]; // radius + spin direction per ring (counter-rotating)
const FM_RINGEDGE = FM_E.map(([p, q]) => {
  const A = FM_FLAT[p],
    B = FM_FLAT[q];
  return A.ri === B.ri && ((A.k + 1) % A.n === B.k || (B.k + 1) % B.n === A.k);
});
function Firstmate({
  state = "idle",
  size = 280,
  level = 0,
  kick = 0,
  style
}) {
  const ref = React.useRef(null);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const levelRef = React.useRef(level);
  levelRef.current = level;
  const kickRef = React.useRef(kick);
  kickRef.current = kick;
  React.useEffect(() => {
    const canvas = ref.current,
      ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    let accent = "#7fdcff",
      dim = "#5d6884",
      hot = "#ffa257",
      accRgb = fmRgb(accent),
      dimRgb = fmRgb(dim),
      hotRgb = fmRgb(hot),
      boost = 1,
      lastRead = 0;
    let raf,
      a = 0.4,
      b = 0.9,
      hs = 0,
      vel = 0.5,
      lastKick = kickRef.current,
      last = performance.now();
    const cur = {
      sa: 0.05,
      sb: 0.03,
      pulse: 0.05,
      glow: 0.35,
      shimmer: 0,
      breath: 0,
      flat: 0,
      heat: 0
    };
    function frame(now) {
      if (now - lastRead > 400) {
        // re-read theme colors so a live theme switch re-paints the character
        const cs = getComputedStyle(canvas);
        accent = (cs.getPropertyValue("--wire-accent") || cs.getPropertyValue("--accent") || accent).trim();
        dim = (cs.getPropertyValue("--wire-dim") || cs.getPropertyValue("--fg-3") || dim).trim();
        hot = (cs.getPropertyValue("--wire-hot") || hot).trim();
        boost = parseFloat(cs.getPropertyValue("--wire-boost")) || 1;
        accRgb = fmRgb(accent);
        dimRgb = fmRgb(dim);
        hotRgb = fmRgb(hot);
        lastRead = now;
      }
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const t = FM_STATES[stateRef.current] || FM_STATES.idle;
      for (const k in cur) cur[k] += (t[k] - cur[k]) * Math.min(dt * 4, 1); // ease between states — the shapeshift is this same continuous blend
      // listening spin: default velocity, accelerated by voice level and keystroke kicks, decaying smoothly back
      if (kickRef.current !== lastKick) {
        vel = Math.min(vel + (kickRef.current - lastKick) * 1.4, 30);
        lastKick = kickRef.current;
      }
      vel += (0.5 + (levelRef.current || 0) * 6 - vel) * Math.min(dt * 1.5, 1);
      a += cur.sa * dt;
      b += cur.sb * dt;
      hs += dt * vel * cur.flat;
      const c = size / 2;
      // working runs hot: bright wires blend from ice cyan to ember, glow follows; the far side heats too (darker ember) so both ends stay one family
      const briRgb = [accRgb[0] + (hotRgb[0] - accRgb[0]) * cur.heat, accRgb[1] + (hotRgb[1] - accRgb[1]) * cur.heat, accRgb[2] + (hotRgb[2] - accRgb[2]) * cur.heat];
      const dimRgbUse = [dimRgb[0] + (hotRgb[0] * 0.55 - dimRgb[0]) * cur.heat, dimRgb[1] + (hotRgb[1] * 0.5 - dimRgb[1]) * cur.heat, dimRgb[2] + (hotRgb[2] * 0.45 - dimRgb[2]) * cur.heat];
      const glowCol = fmMix(accRgb, hotRgb, cur.heat);
      // listening: slow deep breath + live voice level; other states stay dimensionally steady
      const breathe = 1 + cur.breath * Math.sin(now / 650) + (levelRef.current || 0) * cur.breath * 1.6;
      const R = size * 0.27 * breathe;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      // ambient glow — pulses gently while listening
      const glowA = cur.glow * (0.10 + cur.heat * 0.16 + cur.breath * 0.6 * (0.5 + 0.5 * Math.sin(now / 650)));
      const g = ctx.createRadialGradient(c, c, 0, c, c, size / 2);
      g.addColorStop(0, fmRgba(glowCol, glowA));
      g.addColorStop(1, fmRgba(glowCol, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      // rotate xw & yz, project 4D->3D->2D
      const ca = Math.cos(a),
        sa2 = Math.sin(a),
        cb = Math.cos(b),
        sb2 = Math.sin(b);
      const pts = FM_V.map(([x, y, z, w]) => {
        const x1 = x * ca - w * sa2,
          w1 = x * sa2 + w * ca;
        const y1 = y * cb - z * sb2,
          z1 = y * sb2 + z * cb;
        const k4 = 2.6 / (2.6 - w1 * 0.55);
        const X = x1 * k4,
          Y = y1 * k4,
          Z = z1 * k4;
        const k3 = 3.4 / (3.4 - Z * 0.5);
        return [c + X * k3 * R * 0.5, c + Y * k3 * R * 0.5, (k4 + k3) / 2, w1];
      });
      // morph toward the flat listening form: lerp every projected vertex to its ring slot
      const f = cur.flat * cur.flat * (3 - 2 * cur.flat);
      if (f > 0.001) {
        const Rf = size * 0.40 * breathe;
        for (let i = 0; i < 16; i++) {
          const F = FM_FLAT[i],
            ang = FM_RING_DIR[F.ri] * hs + F.k / F.n * Math.PI * 2 - Math.PI / 2;
          const P = pts[i];
          P[0] += (c + Math.cos(ang) * FM_RING_R[F.ri] * Rf - P[0]) * f;
          P[1] += (c + Math.sin(ang) * FM_RING_R[F.ri] * Rf - P[1]) * f;
        }
      }
      ctx.lineWidth = 1.4;
      // neon pass: hot wires cast a real glow (canvas shadow) and get a white-hot core
      const neon = cur.heat;
      if (neon > 0.02) {
        ctx.shadowColor = fmRgba(fmMix(hotRgb, [255, 236, 200], 0.3), Math.min(1, 0.9 * neon));
        ctx.shadowBlur = 14 * neon * (size / 280);
      }
      for (let i = 0; i < FM_E.length; i++) {
        const [p, q] = FM_E[i],
          P = pts[p],
          Q = pts[q];
        const depth = (P[2] + Q[2]) / 2 - 0.9;
        let alpha = Math.max(0.3, Math.min(0.9, 0.35 + depth * 0.5)) * boost;
        if (cur.shimmer > 0) alpha *= 1 - cur.shimmer * 0.3 * (0.5 + 0.5 * Math.sin(now / 240 + i * 2.7)); // gentle, low-frequency shimmer — fast alpha strobing flickers badly under acrylic blur
        // in the flat form only ring edges remain; cross edges (spokes) fade out with the morph
        if (!FM_RINGEDGE[i]) {
          alpha *= 1 - f;
          if (alpha < 0.02) continue;
        } else alpha += (Math.min(1, 0.85 * boost) - alpha) * f;
        // smooth inner/outer blend on w — no discrete color/alpha pop as edges cross w=0
        const m = Math.max(Math.max(0, Math.min(1, 0.5 + (P[3] + Q[3]) * 0.35)), f * 0.9);
        ctx.strokeStyle = fmMix(dimRgbUse, briRgb, m);
        ctx.globalAlpha = Math.min(1, alpha * (0.85 + 0.15 * m));
        ctx.beginPath();
        ctx.moveTo(P[0], P[1]);
        ctx.lineTo(Q[0], Q[1]);
        ctx.stroke();
        if (neon > 0.02 && m > 0.5) {
          // white-hot filament core on the bright edges
          ctx.globalAlpha = Math.min(1, alpha) * neon * 0.85;
          ctx.strokeStyle = fmMix(briRgb, [255, 244, 224], 0.75);
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(P[0], P[1]);
          ctx.lineTo(Q[0], Q[1]);
          ctx.stroke();
          ctx.lineWidth = 1.4;
        }
      }
      for (let i = 0; i < pts.length; i++) {
        const P = pts[i];
        const pulse = 1 + cur.pulse * 0.6 * Math.max(0, Math.sin(now / 300 + i * 0.8));
        const m = Math.max(Math.max(0, Math.min(1, 0.5 + P[3] * 0.6)), f);
        const r = (2.1 + 0.7 * m) * pulse * (size / 280);
        ctx.globalAlpha = Math.min(1, Math.max(0.65, Math.min(1, 0.6 + (P[2] - 0.9) * 0.5)) * boost);
        ctx.fillStyle = fmMix(dimRgbUse, briRgb, Math.max(m, 0.35)); // keep far-side dots from dimming into bright foreground lines
        ctx.beginPath();
        ctx.arc(P[0], P[1], r, 0, Math.PI * 2);
        ctx.fill();
        if (neon > 0.02 && m > 0.4) {
          // incandescent dot cores
          ctx.globalAlpha = neon;
          ctx.fillStyle = fmMix(briRgb, [255, 248, 235], 0.8);
          ctx.beginPath();
          ctx.arc(P[0], P[1], r * 0.45, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size]);
  return /*#__PURE__*/React.createElement("canvas", {
    ref: ref,
    "aria-label": "First mate — " + state,
    style: {
      width: size,
      height: size,
      display: "block",
      ...style
    }
  });
}
Object.assign(__ds_scope, { Firstmate });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/mate/Firstmate.jsx", error: String((e && e.message) || e) }); }

// components/quota/SlotBadge.jsx
try { (() => {
const slotMeta = {
  high: {
    label: "High",
    color: "var(--bucket-high)"
  },
  medium: {
    label: "Med",
    color: "var(--bucket-medium)"
  },
  low: {
    label: "Low",
    color: "var(--bucket-low)"
  }
};
function SlotBadge({
  slot = "medium",
  style
}) {
  const b = slotMeta[bucket] || bucketMeta.medium;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-xs)",
      fontWeight: 500,
      letterSpacing: "var(--tracking-label)",
      textTransform: "uppercase",
      color: b.color,
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      gap: 2,
      alignItems: "flex-end"
    }
  }, [0, 1, 2].map(i => /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      width: 3,
      height: 4 + i * 2,
      borderRadius: 1,
      background: i < (slot === "high" ? 3 : slot === "medium" ? 2 : 1) ? b.color : "var(--bg-3)"
    }
  }))), b.label);
}
Object.assign(__ds_scope, { SlotBadge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/quota/SlotBadge.jsx", error: String((e && e.message) || e) }); }

// components/quota/QuotaMeter.jsx
try { (() => {
const paceColors = {
  ahead: "var(--ok)",
  on_pace: "var(--accent)",
  behind: "var(--warn)",
  unknown: "var(--idle)"
};
const paceLabels = {
  ahead: "ahead",
  on_pace: "on pace",
  behind: "behind",
  unknown: "—"
};
function QuotaMeter({
  label,
  percentRemaining,
  pace = "unknown",
  resetText,
  style
}) {
  const known = typeof percentRemaining === "number";
  const low = known && percentRemaining <= 10;
  const color = low ? "var(--danger)" : paceColors[pace] || paceColors.unknown;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 6,
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-xs)",
      fontWeight: 500,
      letterSpacing: "var(--tracking-label)",
      textTransform: "uppercase",
      color: "var(--fg-3)"
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-sm)",
      color: "var(--fg-2)",
      whiteSpace: "nowrap"
    }
  }, known ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--fg-1)"
    }
  }, Math.round(percentRemaining), "% left") : "no data", known && /*#__PURE__*/React.createElement("span", null, " \xB7 ", /*#__PURE__*/React.createElement("span", {
    style: {
      color
    }
  }, low ? "low" : paceLabels[pace])), resetText && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--fg-3)"
    }
  }, " \xB7 ", resetText))), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 3,
      borderRadius: 2,
      background: "var(--bg-3)",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: "100%",
      width: (known ? percentRemaining : 0) + "%",
      background: color,
      borderRadius: 2,
      transition: "width var(--dur-slow) var(--ease-drift)"
    }
  })));
}
Object.assign(__ds_scope, { QuotaMeter });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/quota/QuotaMeter.jsx", error: String((e && e.message) || e) }); }

// components/quota/SubscriptionCard.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function SubscriptionCard({
  provider,
  plan,
  account,
  status = "fresh",
  windows = [],
  models = [],
  width = 340,
  style
}) {
  const stateTone = status === "fresh" ? "ok" : status === "stale" ? "warn" : "danger";
  const stateLabel = status === "fresh" ? "live" : status === "stale" ? "stale" : status.replace("_", " ");
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width,
      boxSizing: "border-box",
      background: "var(--surface-card)",
      border: "1px solid var(--line-1)",
      borderRadius: "var(--radius-l)",
      boxShadow: "var(--shadow-2)",
      padding: "18px 20px",
      display: "flex",
      flexDirection: "column",
      gap: 14,
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 2,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-md)",
      fontWeight: 600,
      color: "var(--fg-1)"
    }
  }, provider), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-xs)",
      color: "var(--fg-3)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, plan, account ? " · " + account : "")), /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    tone: stateTone,
    dot: true,
    mono: true
  }, stateLabel)), windows.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 10
    }
  }, windows.map((w, i) => /*#__PURE__*/React.createElement(__ds_scope.QuotaMeter, _extends({
    key: i
  }, w)))), models.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 6,
      borderTop: "1px solid var(--line-1)",
      paddingTop: 12
    }
  }, models.map((m, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-sm)",
      color: m.override ? "var(--accent)" : "var(--fg-2)"
    }
  }, m.label, m.override ? " ✱" : ""), /*#__PURE__*/React.createElement(__ds_scope.SlotBadge, {
    slot: m.slot
  })))));
}
Object.assign(__ds_scope, { SubscriptionCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/quota/SubscriptionCard.jsx", error: String((e && e.message) || e) }); }

// components/voice/VoiceInput.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const vicoS = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round"
};
const VIco = {
  x: /*#__PURE__*/React.createElement("svg", _extends({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24"
  }, vicoS), /*#__PURE__*/React.createElement("path", {
    d: "M18 6 6 18M6 6l12 12"
  })),
  check: /*#__PURE__*/React.createElement("svg", _extends({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24"
  }, vicoS), /*#__PURE__*/React.createElement("path", {
    d: "M20 6 9 17l-5-5"
  })),
  up: /*#__PURE__*/React.createElement("svg", _extends({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24"
  }, vicoS), /*#__PURE__*/React.createElement("path", {
    d: "m5 12 7-7 7 7M12 19V5"
  }))
};
function Waveform({
  level = 0.6,
  height = 28
}) {
  const ref = React.useRef(null);
  const levelRef = React.useRef(level);
  levelRef.current = level;
  React.useEffect(() => {
    const canvas = ref.current,
      ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    let raf,
      w = 0,
      accent = "#7fdcff",
      lastRead = 0;
    function frame(now) {
      if (now - lastRead > 400) {
        accent = (getComputedStyle(canvas).getPropertyValue("--accent") || accent).trim();
        lastRead = now;
      }
      const cw = canvas.clientWidth;
      if (cw !== w) {
        w = cw;
        canvas.width = w * dpr;
        canvas.height = height * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, height);
      const n = Math.floor(w / 5);
      ctx.fillStyle = accent;
      for (let i = 0; i < n; i++) {
        const ph = now / 180 + i * 0.9;
        const env = Math.exp(-Math.pow((i - n / 2) / (n / 2.6), 2)); // taper at both ends
        const h = Math.max(2, (Math.sin(ph) * 0.5 + 0.5) * (0.3 + 0.7 * levelRef.current) * height * env);
        ctx.globalAlpha = 0.4 + 0.6 * env;
        ctx.fillRect(i * 5, (height - h) / 2, 2.5, h);
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [height]);
  return /*#__PURE__*/React.createElement("canvas", {
    ref: ref,
    style: {
      width: "100%",
      height,
      display: "block"
    }
  });
}
function VoiceInput({
  mode = "idle",
  keybindHint = "type, or press/hold right ⌥ to talk",
  value,
  onChange,
  level = 0.6,
  onActivate,
  onAbandon,
  onAccept,
  onSubmit,
  onFocusChange,
  onKeystroke,
  width = 560,
  style
}) {
  const [focus, setFocus] = React.useState(false);
  const shell = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width,
    boxSizing: "border-box",
    height: 52,
    padding: "0 10px",
    borderRadius: "var(--radius-pill)",
    background: "var(--surface-input)",
    border: "1px solid " + (mode === "recording" ? "var(--line-2)" : focus ? "var(--line-2)" : "var(--line-1)"),
    boxShadow: mode === "recording" ? "var(--glow-accent)" : focus ? "var(--focus-ring)" : "var(--shadow-1)",
    transition: "border-color var(--dur-med) var(--ease-out),box-shadow var(--dur-med) var(--ease-out)",
    ...style
  };
  if (mode === "recording") {
    return /*#__PURE__*/React.createElement("div", {
      style: shell
    }, /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
      label: "Abandon",
      tone: "danger",
      onClick: onAbandon
    }, VIco.x), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement(Waveform, {
      level: level
    })), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
      label: "Accept",
      tone: "ok",
      onClick: onAccept
    }, VIco.check), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
      label: "Submit",
      tone: "accent",
      onClick: onSubmit,
      style: {
        background: "var(--accent-dim)"
      }
    }, VIco.up));
  }
  // Plain click focuses the input for typing; voice activation is keybind-only (onActivate is wired by the host to the key, not to click).
  return /*#__PURE__*/React.createElement("div", {
    style: shell
  }, /*#__PURE__*/React.createElement("input", {
    value: value,
    onChange: onChange,
    onFocus: () => {
      setFocus(true);
      onFocusChange && onFocusChange(true);
    },
    onBlur: () => {
      setFocus(false);
      onFocusChange && onFocusChange(false);
    },
    onKeyDown: e => {
      if (e.key === "Enter" && value && onSubmit) {
        onSubmit();
        return;
      }
      onKeystroke && onKeystroke();
    },
    placeholder: keybindHint,
    style: {
      flex: 1,
      minWidth: 0,
      background: "transparent",
      border: "none",
      outline: "none",
      fontFamily: "var(--font-ui)",
      fontSize: "var(--text-md)",
      color: "var(--fg-1)",
      padding: "0 8px",
      textAlign: value ? "left" : "center"
    }
  }), value ? /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    label: "Submit",
    tone: "accent",
    onClick: onSubmit,
    style: {
      background: "var(--accent-dim)"
    }
  }, VIco.up) : null);
}
Object.assign(__ds_scope, { VoiceInput });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/voice/VoiceInput.jsx", error: String((e && e.message) || e) }); }

// ui_kits/firstmate/AppShell.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const NS = window.InfinitaryDesignSystem_94f559;
const {
  Firstmate,
  Crewmate,
  CrewStrip,
  ActivityFeed,
  VoiceInput,
  ResponseCard,
  CardStack,
  Button,
  IconButton,
  Badge,
  Switch,
  QuotaMeter,
  SubscriptionCard,
  MachineRow,
  Input,
  KeyCap
} = NS;
const appIcoS = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round"
};
const AppIco = {
  gear: /*#__PURE__*/React.createElement("svg", _extends({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24"
  }, appIcoS), /*#__PURE__*/React.createElement("path", {
    d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "3"
  })),
  back: /*#__PURE__*/React.createElement("svg", _extends({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24"
  }, appIcoS), /*#__PURE__*/React.createElement("path", {
    d: "m15 18-6-6 6-6"
  })),
  sun: /*#__PURE__*/React.createElement("svg", _extends({
    width: "15",
    height: "15",
    viewBox: "0 0 24 24"
  }, appIcoS), /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "4"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
  }))
};
const DEMO_CARDS = [{
  kind: "decision",
  title: "Two ways to fix the flaky test",
  meta: "just now · crewmate 4",
  body: "The retry helper races a 50ms timer. Awaiting the job queue removes the race entirely; mocking the clock is faster but leaves the race in production code.",
  actions: ["Later", "Mock the clock", "Await the queue"]
}, {
  kind: "result",
  title: "Refactor finished",
  meta: "2m ago · atlas",
  body: "14 files changed, tests green. Two snapshots updated; nothing else moved.",
  actions: ["View diff"]
}, {
  kind: "info",
  title: "Quota note",
  meta: "12m ago",
  body: "Claude opus weekly is at 9% — routing high-bucket work to Grok until Friday's reset.",
  actions: ["Override"]
}];
const now = Date.now();
const DEMO_EVENTS = [{
  time: now - 1140000,
  kind: "spawn",
  text: "crewmate spawned — refactor auth middleware"
}, {
  time: now - 960000,
  kind: "report",
  text: "auth tests green on atlas"
}, {
  time: now - 840000,
  kind: "done",
  text: "crewmate decommissioned — auth middleware landed"
}, {
  time: now - 720000,
  kind: "report",
  text: "test matrix green across 3 machines"
}, {
  time: now - 540000,
  kind: "done",
  text: "crewmate decommissioned — lint sweep complete"
}, {
  time: now - 420000,
  kind: "spawn",
  text: "crewmate spawned — typecheck the settings tree"
}, {
  time: now - 300000,
  kind: "report",
  text: "no new type errors"
}, {
  time: now - 180000,
  kind: "spawn",
  text: "crewmate spawned — investigate flaky CI job"
}, {
  time: now - 120000,
  kind: "report",
  text: "flake isolated to retry helper"
}, {
  time: now - 60000,
  kind: "report",
  text: "found root cause: race in retry helper"
}, {
  time: now - 30000,
  kind: "done",
  text: "crewmate decommissioned — flake fix up for review"
}, {
  time: now,
  kind: "spawn",
  text: "crewmate spawned — widen the home activity feed"
}];
function TopBar({
  view,
  onSettings,
  onBack,
  theme,
  onTheme,
  working
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: 52,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 16px",
      WebkitAppRegion: "drag"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, view === "settings" ? /*#__PURE__*/React.createElement(IconButton, {
    label: "Back",
    onClick: onBack
  }, AppIco.back) : /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-sm)",
      fontWeight: 500,
      color: "var(--fg-3)",
      letterSpacing: "var(--tracking-display)"
    }
  }, "Infinitary"), view === "settings" && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-base)",
      color: "var(--fg-1)",
      fontWeight: 500
    }
  }, "Settings")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6
    }
  }, view !== "settings" && /*#__PURE__*/React.createElement(IconButton, {
    label: "Settings",
    onClick: onSettings
  }, AppIco.gear)));
}
function HomeScreen({
  phase,
  setPhase,
  cardIdx,
  setCardIdx,
  dismiss
}) {
  const working = phase === "working" || phase === "thinking";
  const showCards = phase === "working";
  const [typing, setTyping] = React.useState(false);
  const [text, setText] = React.useState("");
  const [kick, setKick] = React.useState(0);
  const listening = phase === "recording" || typing && text.length > 0;
  const card = DEMO_CARDS[cardIdx];
  const timerRef = React.useRef(null);
  React.useEffect(() => () => clearTimeout(timerRef.current), []);
  const submit = () => {
    setText("");
    setPhase("thinking");
    setCardIdx(0);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setPhase("working"), 5000);
  };
  // Fixed vertical geometry: Firstmate layer and card layer are absolutely positioned; the input never moves.
  return /*#__PURE__*/React.createElement("div", {
    "data-screen-label": showCards ? "Working" : listening ? "Listening" : "Null state",
    style: {
      position: "absolute",
      inset: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      left: "50%",
      top: "calc(50% - 60px)",
      transform: "translate(-50%,-50%)",
      opacity: showCards ? 0.45 : 1,
      filter: showCards ? "blur(3px)" : "none",
      transition: "opacity var(--dur-slow) var(--ease-out),filter var(--dur-slow) var(--ease-out)"
    }
  }, /*#__PURE__*/React.createElement(Firstmate, {
    state: listening ? "listening" : working ? "working" : "idle",
    size: 300,
    level: phase === "recording" ? 0.6 : 0,
    kick: kick
  })), showCards && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      left: "50%",
      top: "calc(50% - 60px)",
      transform: "translate(-50%,-50%)"
    }
  }, /*#__PURE__*/React.createElement(CardStack, {
    index: cardIdx,
    count: DEMO_CARDS.length,
    width: 560,
    onPrev: () => setCardIdx(Math.max(0, cardIdx - 1)),
    onNext: () => setCardIdx(Math.min(DEMO_CARDS.length - 1, cardIdx + 1))
  }, /*#__PURE__*/React.createElement(ResponseCard, {
    kind: card.kind,
    title: card.title,
    meta: card.meta,
    onClose: dismiss,
    actions: card.actions.map((a, i) => /*#__PURE__*/React.createElement(Button, {
      key: a,
      variant: i === card.actions.length - 1 ? "primary" : i === 0 ? "ghost" : "secondary",
      onClick: dismiss
    }, a))
  }, card.body))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      left: "50%",
      bottom: 96,
      transform: "translateX(-50%)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(VoiceInput, {
    mode: phase === "recording" ? "recording" : "idle",
    width: 560,
    level: 0.6,
    value: text,
    onChange: e => setText(e.target.value),
    onFocusChange: setTyping,
    onKeystroke: () => setKick(k => k + 1),
    onAbandon: () => setPhase(working ? "working" : "idle"),
    onAccept: () => setPhase(working ? "working" : "idle"),
    onSubmit: submit
  })));
}
function App() {
  const [theme, setTheme] = React.useState("dark");
  const [view, setView] = React.useState("home");
  const [phase, setPhase] = React.useState("idle");
  const [cardIdx, setCardIdx] = React.useState(0);
  React.useEffect(() => {
    document.body.dataset.theme = theme;
  }, [theme]);
  React.useEffect(() => {
    const h = e => {
      if (e.key === "Escape" && phase === "recording") {
        setPhase("idle");
        return;
      }
      if (e.key === "Alt" && e.location === 2 && phase !== "recording" && view === "home") {
        e.preventDefault();
        setPhase("recording");
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [phase, view]);
  const working = phase === "working" || phase === "thinking";
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      background: "var(--bg-0)",
      overflow: "hidden",
      fontFamily: "var(--font-ui)"
    }
  }, view === "home" && /*#__PURE__*/React.createElement(HomeScreen, {
    phase: phase,
    setPhase: setPhase,
    cardIdx: cardIdx,
    setCardIdx: setCardIdx,
    dismiss: () => setPhase("idle")
  }), view === "settings" && /*#__PURE__*/React.createElement(window.FM_SettingsScreen, {
    theme: theme,
    onTheme: () => setTheme(theme === "dark" ? "light" : "dark")
  }), /*#__PURE__*/React.createElement(TopBar, {
    view: view,
    working: working && view === "home",
    theme: theme,
    onTheme: () => setTheme(theme === "dark" ? "light" : "dark"),
    onSettings: () => setView("settings"),
    onBack: () => setView("home")
  }), view === "home" && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      left: 16,
      bottom: 14,
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",
      gap: 8
    }
  }, working && ActivityFeed && /*#__PURE__*/React.createElement(ActivityFeed, {
    events: DEMO_EVENTS,
    style: {
      maxWidth: "calc(50vw - 320px)",
      height: "33vh"
    }
  }), /*#__PURE__*/React.createElement(CrewStrip, {
    working: working ? 3 : 0,
    idle: working ? 5 : 8
  })));
}
window.FM_App = App;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/firstmate/AppShell.jsx", error: String((e && e.message) || e) }); }

// ui_kits/firstmate/SettingsScreen.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const NS2 = window.InfinitaryDesignSystem_94f559;
const {
  SubscriptionCard,
  MachineRow,
  Button,
  Input,
  Switch,
  Badge
} = NS2;
const SUBS = [{
  provider: "Claude",
  plan: "Max 20x",
  account: "kun@gmail.com",
  status: "fresh",
  windows: [{
    label: "session",
    percentRemaining: 74,
    pace: "ahead",
    resetText: "resets 3pm"
  }, {
    label: "weekly",
    percentRemaining: 62,
    pace: "on_pace",
    resetText: "resets Fri"
  }, {
    label: "opus weekly",
    percentRemaining: 9,
    pace: "behind",
    resetText: "resets Fri"
  }],
  models: [{
    label: "opus 5",
    bucket: "high",
    override: true
  }, {
    label: "sonnet 5",
    bucket: "medium"
  }, {
    label: "haiku 4.5",
    bucket: "low"
  }]
}, {
  provider: "Codex",
  plan: "Pro",
  account: "kun@gmail.com",
  status: "fresh",
  windows: [{
    label: "5h window",
    percentRemaining: 88,
    pace: "ahead",
    resetText: "resets 9pm"
  }, {
    label: "weekly",
    percentRemaining: 41,
    pace: "on_pace",
    resetText: "resets Sun"
  }],
  models: [{
    label: "gpt-6",
    bucket: "high"
  }, {
    label: "gpt-6-mini",
    bucket: "medium"
  }]
}, {
  provider: "Grok",
  plan: "SuperGrok",
  account: "kun@gmail.com",
  status: "stale",
  windows: [{
    label: "credits",
    percentRemaining: 57,
    pace: "unknown"
  }],
  models: [{
    label: "grok 5",
    bucket: "high"
  }, {
    label: "grok 5 fast",
    bucket: "low"
  }]
}];
const MACHINES = [{
  name: "atlas",
  host: "kun@atlas.local:22",
  specs: "32c · 128 GB · RTX 4090",
  cpu: 42,
  mem: 61,
  tasks: 2
}, {
  name: "sloop",
  host: "kun@10.0.0.7",
  specs: "8c · 16 GB",
  cpu: 88,
  mem: 71,
  tasks: 1
}, {
  name: "dinghy",
  host: "kun@dinghy.tail3f.ts.net",
  specs: "4c · 8 GB",
  status: "offline",
  tasks: 0
}];
function SectionLabel({
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-xs)",
      fontWeight: 500,
      letterSpacing: "var(--tracking-label)",
      textTransform: "uppercase",
      color: "var(--fg-3)",
      marginBottom: 14
    }
  }, children);
}
function SettingsScreen({
  theme,
  onTheme
}) {
  const [tab, setTab] = React.useState("general");
  const [routing, setRouting] = React.useState(true);
  const [loginStart, setLoginStart] = React.useState(true);
  const [dock, setDock] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", {
    "data-screen-label": "Settings",
    style: {
      position: "absolute",
      inset: 0,
      paddingTop: 64,
      display: "flex",
      justifyContent: "center",
      overflowY: "auto"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 760,
      padding: "8px 20px 48px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4,
      marginBottom: 28,
      borderBottom: "1px solid var(--line-1)",
      paddingBottom: 0
    }
  }, [["general", "General"], ["subscriptions", "Subscriptions"], ["machines", "Machines"]].map(([id, label]) => /*#__PURE__*/React.createElement("button", {
    key: id,
    onClick: () => setTab(id),
    style: {
      background: "transparent",
      border: "none",
      cursor: "pointer",
      fontFamily: "var(--font-ui)",
      fontSize: "var(--text-base)",
      fontWeight: 500,
      color: tab === id ? "var(--fg-1)" : "var(--fg-3)",
      padding: "10px 14px",
      borderBottom: tab === id ? "2px solid var(--accent)" : "2px solid transparent",
      marginBottom: -1
    }
  }, label))), tab === "general" && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SectionLabel, null, "General"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "14px 18px",
      background: "var(--bg-1)",
      border: "1px solid var(--line-1)",
      borderRadius: "var(--radius-m)"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-base)",
      color: "var(--fg-1)",
      fontWeight: 500
    }
  }, "Dark theme"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-sm)",
      color: "var(--fg-3)"
    }
  }, "Deep-space dark, or daylight light.")), /*#__PURE__*/React.createElement(Switch, {
    checked: theme === "dark",
    onChange: onTheme
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "14px 18px",
      background: "var(--bg-1)",
      border: "1px solid var(--line-1)",
      borderRadius: "var(--radius-m)"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-base)",
      color: "var(--fg-1)",
      fontWeight: 500
    }
  }, "Start at login"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-sm)",
      color: "var(--fg-3)"
    }
  }, "Launch Infinitary when you sign in.")), /*#__PURE__*/React.createElement(Switch, {
    checked: loginStart,
    onChange: setLoginStart
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "14px 18px",
      background: "var(--bg-1)",
      border: "1px solid var(--line-1)",
      borderRadius: "var(--radius-m)"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-base)",
      color: "var(--fg-1)",
      fontWeight: 500
    }
  }, "Show in dock"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-sm)",
      color: "var(--fg-3)"
    }
  }, "Off keeps Infinitary in the menu bar only.")), /*#__PURE__*/React.createElement(Switch, {
    checked: dock,
    onChange: setDock
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "14px 18px",
      background: "var(--bg-1)",
      border: "1px solid var(--line-1)",
      borderRadius: "var(--radius-m)"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-base)",
      color: "var(--fg-1)",
      fontWeight: 500
    }
  }, "Talk keybind"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-sm)",
      color: "var(--fg-3)"
    }
  }, "Press/hold to talk from anywhere.")), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    size: "sm"
  }, "right \u2325")))), tab === "subscriptions" && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement(SectionLabel, null, "AI subscriptions \xB7 quota tracked live"), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    size: "sm"
  }, "Add subscription")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 16,
      marginBottom: 24
    }
  }, SUBS.map(s => /*#__PURE__*/React.createElement(SubscriptionCard, _extends({
    key: s.provider,
    width: "auto"
  }, s))), /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px dashed var(--line-2)",
      borderRadius: "var(--radius-l)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      minHeight: 160,
      color: "var(--fg-3)",
      fontSize: "var(--text-sm)"
    }
  }, "Sign in to add another provider")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "14px 18px",
      background: "var(--bg-1)",
      border: "1px solid var(--line-1)",
      borderRadius: "var(--radius-m)"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-base)",
      color: "var(--fg-1)",
      fontWeight: 500
    }
  }, "Dynamic routing"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-sm)",
      color: "var(--fg-3)"
    }
  }, "Assign tasks to crewmates by difficulty, bucket and remaining quota. \u2731 overrides always win.")), /*#__PURE__*/React.createElement(Switch, {
    checked: routing,
    onChange: setRouting
  }))), tab === "machines" && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement(SectionLabel, null, "Machine pool \xB7 tasks placed by spec + load"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 220
    }
  }, /*#__PURE__*/React.createElement(Input, {
    placeholder: "user@host",
    mono: true
  })), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    size: "sm"
  }, "Add machine"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 10
    }
  }, MACHINES.map(m => /*#__PURE__*/React.createElement(MachineRow, _extends({
    key: m.name
  }, m)))))));
}
window.FM_SettingsScreen = SettingsScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/firstmate/SettingsScreen.jsx", error: String((e && e.message) || e) }); }

__ds_ns.CardStack = __ds_scope.CardStack;

__ds_ns.ResponseCard = __ds_scope.ResponseCard;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.KeyCap = __ds_scope.KeyCap;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.MachineRow = __ds_scope.MachineRow;

__ds_ns.ActivityFeed = __ds_scope.ActivityFeed;

__ds_ns.CrewStrip = __ds_scope.CrewStrip;

__ds_ns.Crewmate = __ds_scope.Crewmate;

__ds_ns.Firstmate = __ds_scope.Firstmate;

__ds_ns.SlotBadge = __ds_scope.SlotBadge;

__ds_ns.QuotaMeter = __ds_scope.QuotaMeter;

__ds_ns.SubscriptionCard = __ds_scope.SubscriptionCard;

__ds_ns.VoiceInput = __ds_scope.VoiceInput;

})();
