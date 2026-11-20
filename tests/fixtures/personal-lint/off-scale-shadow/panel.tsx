import { Empty } from "@firstmate/ui";

export default function Panel({ store }: { store: { note?: string } }) {
  if (!store.note) return <Empty>Nothing noted</Empty>;
  return (
    <div style={{ boxShadow: "0 10px 26px -10px rgba(0, 0, 0, 0.55)", color: "var(--fg-2)" }}>
      {store.note}
    </div>
  );
}
