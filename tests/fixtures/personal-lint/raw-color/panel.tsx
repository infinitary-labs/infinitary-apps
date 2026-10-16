import { Empty, Row } from "@firstmate/ui";

export default function Panel({ store }: { store: { names?: string[] } }) {
  const names = store.names ?? [];
  if (names.length === 0) return <Empty>Nothing to show</Empty>;
  return (
    <div style={{ color: "#80ddff", borderTop: "1px solid rgba(150, 180, 255, 0.5)" }}>
      {names.map((name) => (
        <Row key={name} title={name} />
      ))}
    </div>
  );
}
