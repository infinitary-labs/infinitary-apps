# Single workflow files in task evidence

`inf:work:download-artifact` adds optional `file`, an exact ZIP member to stream, unpack and verify into task evidence without the buffered archive limit.
`inf:session:source-file` adds optional `evidence: true`, selecting the task's evidence folder with no overwrite and removing the legacy total-size bound for this streamed destination alone.
Both sides check `workflow-evidence-file` before sending either field; an older side gets an update refusal before a download starts.
Existing whole archives, selected ZIP archives and source-card or hand-over transfers keep their meanings and bounds.
