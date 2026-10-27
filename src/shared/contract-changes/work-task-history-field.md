# Placed task history field selection

The `inf:work:tasks` request accepts optional `input.field`, retaining a placed crewmate's explicit field selection through the home's request parser.
An explicit timeline request reaches the same source owner as a local query, while ordinary reads keep their focused fields without loading history.
Older senders omit the field and keep ordinary reads; unavailable history remains explicit rather than reconstructed from another field.
