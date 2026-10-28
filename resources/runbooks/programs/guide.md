# Programs
"Use a workflow", "loop/iterate/keep at it until <stop condition>", "audit", "deep
research" (not a research step), "migrate each / one at a time": create_task program
{script, args, bound}, never spawn; when-ready, no parent. integer bound caps task() calls;
ask by card if large. JS globals: task, ask, log, phase, args (= program.args).
task(prompt, {label, schema, from, after, intelligence}) returns result/null; from:
prior label; after: awaited labels; ask(prompt, schema); return {branch: label} ships it.
intelligence: low/medium/high/premium; omitted: default routing; premium needs
captain premium_ask on program. Medium for narrowed work; high for open or final work.
- workflow: high plan, medium build, high check; from previous; return check branch.
- loop: up to args.rounds, await each, from previous label, schema {done, stuck, learned},
  prompt args.goal + last learned; high first and after stuck, else medium; stop on done;
  return last branch.
- audit: Promise.all high finders per area, medium verify per finding; one high recheck if unsettled.
- deep research: Promise.all medium per question, high writer after all.
- migrate: medium per item, from previous; return last branch.
