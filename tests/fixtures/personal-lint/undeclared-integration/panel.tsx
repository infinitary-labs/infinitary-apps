import type { PanelProps } from "@infinitary/contracts";
import { useEffect, useState } from "react";

export default function Panel({ integrations }: PanelProps) {
  const [text, setText] = useState("");
  useEffect(() => {
    void integrations
      .call("github", "read", { path: "/user" })
      .then((answer) => setText(answer.text));
    void integrations.call("github", "write", { path: "/user" });
    return integrations.on("github", "workflow_run_finished", () => undefined);
  }, [integrations]);
  void integrations.show("calendar");
  return <p>{text}</p>;
}
