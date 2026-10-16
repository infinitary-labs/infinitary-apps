import { Empty, MicroLabel, Row } from "@firstmate/ui";

export default function Panel({ store }: { store: { names?: string[] } }) {
  const names = store.names ?? [];
  if (names.length === 0) return <Empty>Nothing to show</Empty>;
  return (
    <div>
      <MicroLabel style={{ color: "var(--accent)" }}>Open</MicroLabel>
      {names.map((name) => (
        <Row key={name} title={name} trailing={<span style={{ color: "var(--hot)" }}>hot</span>} />
      ))}
    </div>
  );
}
