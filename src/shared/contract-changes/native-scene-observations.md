# Native scene observations

`inf:conversation:state` is a view-readable snapshot of the first mate's own busy flag, paired with the existing numbered `firstmate_state` events.
`inf:computers:presence` is a view-readable snapshot and push of work computers' public identifiers, names and observed reach, with no addresses or management operations.
A native view requests these only when the home's welcome lists `native-scene-observations`.
An older home keeps the previous reads and event-only first-mate activity; missing reach stays unknown and reconnect replay creates no transient animation.
The native task reader also retains the already-published tier, work posture, review, execution-device, program and dependency-link facts.
