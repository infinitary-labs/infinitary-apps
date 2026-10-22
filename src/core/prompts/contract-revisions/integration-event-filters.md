# Declared integration event filters

INF-786 implements piece 6 of the accepted INF-775 plan: Calendar changes with a calendar filter on the one Google row.
The `schedule_prompt` tool gains the optional top-level `event_filter` string map; the tool description points to the fields the integration event declares.
Integration discovery discloses these fields only when that integration is read, so an unused integration adds no standing context.
The parameter uses the existing bare-object shape both runtimes support, and the shared string-map schema checks its values before scheduling.
The compact tool description stays within the existing fixed-context budget; no standing prompt paragraph changes.
