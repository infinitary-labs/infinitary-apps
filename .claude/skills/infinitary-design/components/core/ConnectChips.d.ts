export interface ConnectChipsProvider {
  id: string;
  name: string;
  /** subscription | key | escape_hatch: a non-subscription chip carries a mono "API key" note. */
  tier: "subscription" | "key" | "escape_hatch";
  /** Empty means the provider cannot be connected here; the chip disables. */
  authTypes: Array<"oauth" | "api_key">;
  /** Whether this provider's accounts can serve Firstmate itself; false = crew only. */
  servesFirstmate: boolean;
  /** No way in on this computer, and why: `note` beside the chip or stage account, `detail` on hover. */
  unavailable?: { note: string; detail: string };
}
export interface ConnectChipsAccount {
  providerId: string;
  /** The account's label ("Personal", "Work #2"). */
  label: string;
  /** false: a login not signed in yet; the stage shows it with the hollow ring and "not signed in". */
  connected?: boolean;
}
export interface ConnectChipsProps {
  providers: ConnectChipsProvider[];
  accounts?: ConnectChipsAccount[];
  /** The provider whose sign-in is in flight; its chip reads "Connecting...". */
  busyProviderId?: string | null;
  /** stage: the first-launch gate (a connected account shows in place of its chip); foot: the Intelligence tab's row. */
  variant?: "stage" | "foot";
  onConnect?: (provider: ConnectChipsProvider) => void;
  style?: React.CSSProperties;
}
