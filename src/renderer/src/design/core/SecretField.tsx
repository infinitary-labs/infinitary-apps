import type React from "react";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Input, type InputProps } from "./Input";

/** What a form reads from a field it does not control: the value as typed and pasted, line breaks included. */
export type SecretFieldHandle = {
  value: string;
  focus: () => void;
};

export type SecretFieldProps = {
  /** The value, line breaks included; omit it to let the field hold the value and read it through `handle`. */
  value?: string;
  onValue?: (value: string) => void;
  /** The field's value for a form that reads it only when it is sent. */
  handle?: React.Ref<SecretFieldHandle>;
} & Omit<InputProps, "value" | "onChange" | "type" | "ref" | "defaultValue">;

/** A line break shows as one masked character, so the field's text and the value keep the same length. */
const shown = (value: string) => value.replace(/[\r\n]/g, " ");

/**
 * The masked field for a secret's value (the design skill's `SecretField`):
 * a password input, so every character stays hidden from the screen and from
 * accessibility, that still keeps the line breaks of a pasted key or
 * certificate, which a single-line field drops. It holds the value itself and
 * shows each line break as one more masked character; a paste goes into the
 * value whole, and every other edit is replayed onto it by position. Nothing
 * drags text in, and undo is off, since the field cannot replay it.
 */
export function SecretField({ value, onValue, handle, onPaste, ...rest }: SecretFieldProps) {
  const field = useRef<HTMLInputElement>(null);
  const [held, setHeld] = useState("");
  const real = value ?? held;
  const current = useRef(real);
  current.current = real;
  /** Where the edit the browser is about to make starts, read before it makes it. */
  const before = useRef<{ start: number; length: number } | null>(null);
  const caret = useRef<number | null>(null);
  const change = (next: string) => {
    current.current = next;
    if (value === undefined) setHeld(next);
    onValue?.(next);
  };
  useImperativeHandle(handle, () => ({
    get value() {
      return current.current;
    },
    set value(next: string) {
      change(next);
    },
    focus: () => field.current?.focus(),
  }));
  useEffect(() => {
    const input = field.current;
    if (!input) return;
    const read = (event: InputEvent) => {
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault();
        return;
      }
      if (event.inputType === "insertFromDrop") {
        event.preventDefault();
        return;
      }
      before.current = {
        start: input.selectionStart ?? input.value.length,
        length: input.value.length,
      };
    };
    input.addEventListener("beforeinput", read);
    return () => input.removeEventListener("beforeinput", read);
  }, []);
  useLayoutEffect(() => {
    if (caret.current === null || !field.current) return;
    field.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  return (
    <Input
      ref={field}
      type="password"
      autoComplete="off"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      {...rest}
      value={shown(real)}
      onPaste={(event) => {
        onPaste?.(event);
        if (event.defaultPrevented) return;
        const input = event.currentTarget;
        const text = event.clipboardData.getData("text/plain");
        event.preventDefault();
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        caret.current = start + text.length;
        change(current.current.slice(0, start) + text + current.current.slice(end));
      }}
      onChange={(event) => {
        const input = event.currentTarget;
        const edit = before.current;
        before.current = null;
        const now = input.value;
        const after = input.selectionStart ?? now.length;
        const old = current.current;
        if (!edit) {
          // An edit the field could not see start, such as autofill: the text is the value.
          change(now);
          return;
        }
        // The browser replaced old[from, to) with now[from, after).
        const from = Math.min(edit.start, after);
        const to = from + (edit.length - now.length) + (after - from);
        change(old.slice(0, from) + now.slice(from, after) + old.slice(to));
      }}
    />
  );
}
