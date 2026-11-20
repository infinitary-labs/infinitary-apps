import { Empty, Row } from "@firstmate/ui";

export default function Panel() {
  return (
    <div>
      <Row title="Build is green ✅" tone="ok" trailing="2m" />
      <Empty>Nothing else running</Empty>
    </div>
  );
}
