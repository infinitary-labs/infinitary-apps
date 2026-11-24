# Task tags

The first piece of an approved plan for tags on tasks: each project defines tags with a name and a description of which tasks qualify, and a task carries any of its project's tags, each recording who set it.
create_task's new tags parameter owns the rule: the task carries exactly the project's tags it names, set only as the captain asks; update_task's tags points to it.
The project-tags action line owns changing a project's tags when asked, and its current value lists each project's tags with their descriptions and how many tasks carry each.
The tasks tool's rows list a task's tags by name.
The two tags parameters cost about 80 tokens of fixed context.
