// One predicate for the compaction reads and their partial index. Keep
// provenance and replay journals out of the candidate index altogether,
// rather than re-reading their payloads on every over-cap timeline write.
// Concerned events are excluded separately: another table owns that fact.
export const COMPACTION_CANDIDATE = `kind NOT IN ('decided', 'steered', 'interrupted', 'report', 'card_resolved', 'briefed')
  AND CASE WHEN json_valid(data_json) THEN coalesce(json_extract(data_json, '$.journal'), 0) ELSE 0 END != 1`;
