# Integration event filters

An integration event may declare string filter fields, with labels and optional default values, in its view.
An Automation event spec may carry the corresponding `filter` object.
Older clients omit the optional filters and keep the integration's defaults; the Google Calendar event defaults to the primary calendar.
