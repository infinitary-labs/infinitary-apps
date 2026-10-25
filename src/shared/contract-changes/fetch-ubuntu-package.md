# Fetch the Ubuntu package

`FETCH_APP_PATH`'s request takes an optional `package: "deb"`, which asks for the Ubuntu package for the named system and chip rather than its AppImage.
The command for another computer asks it on Ubuntu 24.04 and 26.04 with no Infinitary installed, and installs the package there.
Its answer with a published build carries that build's SHA-256 in the `x-infinitary-sha256` header (`FETCH_APP_SHA256_HEADER`), which root checks the package against before it installs it.
Only a home's own command asks it, and it is always that home's, so an older home is never asked it.
