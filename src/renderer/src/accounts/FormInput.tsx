import { Input, type InputProps } from "../design";

/** A custom connection form field that outlines itself when its text is refused. */
export function FormInput({ invalid = false, ...rest }: InputProps & { invalid?: boolean }) {
  return (
    <Input
      {...rest}
      aria-invalid={invalid || undefined}
      style={{
        ...(invalid ? { borderColor: "var(--danger)" } : {}),
      }}
    />
  );
}
