# A phone says how long its catch-up took

A phone that lists this change sends `{"t":"shown","ms":N}` once per connection, once its catch-up shows: its replay read, or a re-read's first reads answered, `N` milliseconds after it sent its hello.
It sends it only to a home whose welcome lists this change.
The home adds that time to its catch-up log line, and keeps it nowhere else.
An older home is never sent the frame, and an older phone sends none, so its line says no shown time.
