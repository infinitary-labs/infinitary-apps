A change story's after-merge step optionally carries `holds`, the keys of tasks waiting on the change that still need the step's work, so the merge moves their wait onto the step.
An older home drops the field when it reads the story, and those tasks stop waiting at the merge as they did before.
