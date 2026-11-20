import { Empty } from "@firstmate/ui";

export default function Panel({ store }: { store: { note?: string } }) {
  if (!store.note) return <Empty>Nothing noted</Empty>;
  return <p style={{ fontSize: 13, color: "var(--fg-2)" }}>{store.note}</p>;
}
