# Verified folder work closes as finished

INF-1279 fixes successful work in a project's folder being closed as discarded.
The existing `settle_task` description owns the rule: `finished` records done after the first mate verifies an idle folder task's reported result, with `completion_evidence`, and leaves its folder untouched.
The core's settle routing names this mode rather than directing every completed change without a merge to released or discard.
The host checks the existing task, work, guidance, decision and relationship facts and records the declaration; it never interprets the evidence or adds a publication-specific state.
The new mode cannot close an answer or bypass a task-owned branch or pull request's delivery.
The settle description is shortened without removing its existing rules to stay inside the fixed-context budget; no new tool, card effect or permission is added.
