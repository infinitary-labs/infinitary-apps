A custom connection's checked model may carry `status`, the HTTP status the server answered its check with, and `reason`, a short excerpt of a refusal's own reason that the transport checked for echoed secrets.
The form words a 4xx `server` failure as a refusal, with the reason when there is one.
An older side ignores both fields, and a form reading a model without them words the failure as a server error, as before.
