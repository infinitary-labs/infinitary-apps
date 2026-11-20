import { Row } from "@firstmate/ui";

export default function Panel({ store }: { store: { names?: string[] } }) {
  const names = store.names ?? [];
  return (
    <div>
      {names.map((name) => (
        <Row key={name} title={name} />
      ))}
    </div>
  );
}
