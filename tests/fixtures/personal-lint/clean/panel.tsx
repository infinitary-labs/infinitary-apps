import { Empty, MicroLabel, Row } from "@firstmate/ui";

type Check = { name: string; state: "ok" | "warn" | "danger" };

export default function Panel({ store }: { store: { checks?: Check[] } }) {
  const checks = store.checks ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <MicroLabel count={checks.length}>Checks</MicroLabel>
      {checks.length === 0 ? (
        <Empty>Nothing running</Empty>
      ) : (
        checks.map((check) => (
          // A PR number is not a color, and the lint must not say it is.
          <Row key={check.name} title={check.name} tone={check.state} trailing="#186" />
        ))
      )}
    </div>
  );
}
