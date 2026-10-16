import { Empty } from "@firstmate/ui";

export default function Panel({ store }: { store: { note?: string } }) {
  if (!store.note) return <Empty>Nothing noted</Empty>;
  return (
    <div style={{ borderRadius: 9, background: "var(--bg-2)", color: "var(--fg-2)" }}>
      {store.note}
    </div>
  );
}
