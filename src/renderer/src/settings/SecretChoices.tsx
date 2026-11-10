import type { SecretsView } from "@shared/secrets";

type Identity = Pick<SecretsView["entries"][number], "ref" | "label" | "environment">;

/** The permission chooser must distinguish names without changing the saved reference. */
export function SecretChoices({ entries, selected }: { entries: Identity[]; selected: string }) {
  return (
    <>
      {selected && !entries.some((entry) => entry.ref === selected) && (
        <option value={selected}>Secret unavailable · {selected}</option>
      )}
      {entries.map((entry) => (
        <option key={entry.ref} value={entry.ref}>
          {entry.label}
          {entry.environment ? ` · ${entry.environment}` : ""} · {entry.ref}
        </option>
      ))}
    </>
  );
}
