# Usage's reporting line says whether only Claude work goes there

`usageReportingSchema` gains an optional `claudeOnly`, set when only Claude's own records reach the named host and the usage report sends no other model's work there.
The host it names is now where the usage report sends every model's work, an administrator's managed setup included, and else where Claude's records alone go.
A view without the change shows its one line for any host.
