/** Kept for the pages still to move to `StatusBadge` (P13, T3 and T4). */
import { StatusBadge } from "./status-badge";

export const Status = ({ value }: { readonly value: string }) => <StatusBadge status={value} />;
