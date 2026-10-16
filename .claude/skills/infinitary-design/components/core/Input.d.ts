export interface InputProps {
  placeholder?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** JetBrains Mono for hosts, keys, ids. */
  mono?: boolean;
  size?: "md" | "lg";
  style?: React.CSSProperties;
}
