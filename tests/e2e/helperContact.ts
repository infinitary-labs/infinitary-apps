import { HOME_DIAL_TIMEOUT_MS } from "@core/devices/dial";
import { HOME_WELCOME_TIMEOUT_MS } from "@core/devices/homeLink";

// INF-335: a first connection may still be reaching after Playwright's default 5 s.
// TLS and the subsequent WebSocket welcome each have their own limit.
export const FIRST_CONTACT_TIMEOUT_MS = HOME_DIAL_TIMEOUT_MS + HOME_WELCOME_TIMEOUT_MS;
