# Automatic placement declarations

FI3-1694 implements the captain's choice to select a computer for each new task and keep it there, preserving explicit task choices and requested model quality.
The task tools accept declared systems, architectures, exact program names and advisory demand profiles; `automatic` is a start-only Runs on choice.
`create_task.placement_requirements` owns the requirements guidance; the top-level spawn and update parameters refer to it from descriptions the Claude client actually serves.
Spawn keeps its two existing groups one level deep; its thirteenth top-level parameter carries the requirements into the stored work shape.
Create-task constraints, delivery note, basis and internal-step guidance refer to their existing spawn owners instead of repeating them.
No rule or schema validation is removed, and the fixed-context budget and conversation-space promise stay unchanged.
The served fixed context measures 19,389 tokens by the app's count, within the unchanged 19,401-token ceiling.
