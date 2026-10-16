export interface GroupedPillsOption<T extends string = string> {
  value: T;
  label: string;
}

export interface GroupedPillsProps<T extends string = string> {
  name: string;
  htmlName: string;
  value: T;
  options: readonly GroupedPillsOption<T>[];
  onChange?: (value: T) => void;
  disabled?: boolean;
}

export interface GroupedChecksOption<T extends string = string> extends GroupedPillsOption<T> {
  ariaLabel?: string;
}

export interface GroupedChecksProps<T extends string = string> {
  name: string;
  values: readonly T[];
  options: readonly GroupedChecksOption<T>[];
  onChange?: (values: T[]) => void;
  disabled?: boolean;
}
