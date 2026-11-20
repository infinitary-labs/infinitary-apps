import { Empty, Row } from "@firstmate/ui";
import { useEffect, useState } from "react";

export default function Panel() {
  const [rows, setRows] = useState<string[]>([]);
  useEffect(() => {
    fetch("https://api.github.com/user/repos")
      .then((response) => response.json())
      .then((data: string[]) => setRows(data));
  }, []);
  if (rows.length === 0) return <Empty>No repositories</Empty>;
  return (
    <div>
      {rows.map((name) => (
        <Row key={name} title={name} />
      ))}
    </div>
  );
}
