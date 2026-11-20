# Taking over from a copy

A computer that keeps a copy of the record can take over as the home when the home is out of reach (docs/devices.md, "Taking over").
The hello a computer that keeps a copy answers (`inf:standby:hello`) carries `addresses`, where a first mate there would answer; one from before says none.
The order `inf:standby:home` tells a copy what taking over needs that the record does not hold; a home asks it only of a computer whose hello lists this change.
The welcome's `addresses` also list where each computer that keeps a copy would answer, which a device keeps among the home's own and dials when the home does not answer; a computer that took over shows the same key, so a device from before finds it there too.
The welcome carries `takeOver`, the id of the takeover that made this home; a home from a move or from before says none.
A device keeps the id beside the home number it heard with it, and refuses another home that says the same number with another id; a device from before takes either.
The home sends every device the live frame `inf:home:goodbye` before its computer sleeps, which a device from before ignores.
When where its copies would answer changes, the home sends every device the live frame `inf:home:routes` with the addresses its welcome would list now, which a device keeps as it keeps a welcome's; a device from before ignores it.
Two copies that both list this change in their link's hello may ask each other `inf:copy:files` and `inf:copy:piece`, so a computer about to take over brings in a newer copy; a copy from before is never asked them, and a newer copy from before refuses the takeover instead.
A home that keeps copies dials each copy out of its reach only to hear a welcome, as its own way back, a Mac on its list; a home there with a higher number makes it step down.
`inf:standby:views` adds `twoHomes` when another home answers with this home's number, and a view asks `inf:standby:keep-home` to keep one; a home from before never says it, and a view from before shows no question.
A window that hears a second home sends that home `inf:standby:other-home`, naming the home it follows, and on its next welcome tells the home it follows of the second; it tells only a home whose welcome lists this change, and a home from before, or a window from before, says nothing of it.
