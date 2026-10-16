import { Empty, Row } from "@firstmate/ui";
import { useEffect, useState } from "react";

export default function Panel() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    window.firstmate.tasks
      .board({})
      .then((board: { rows: unknown[] }) => setCount(board.rows.length));
  }, []);
  if (count === 0) return <Empty>No tasks</Empty>;
  return <Row title="Tasks" trailing={count} />;
}
