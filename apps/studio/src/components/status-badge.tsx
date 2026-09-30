/**
 * A status, drawn in its tone (P13, D-P13-03). The tone comes from
 * `lib/status.ts`; what a tone looks like comes from `theme.css`.
 */
import { cva } from "class-variance-authority";
import { cn } from "cn";
import { type Tone, toneOf } from "@/lib/status";

const badge = cva(
  "inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-xs font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        success: "bg-status-success text-status-success-foreground",
        warning: "bg-status-warning text-status-warning-foreground",
        danger: "bg-status-danger text-status-danger-foreground",
        info: "bg-status-info text-status-info-foreground",
        neutral: "bg-status-neutral text-status-neutral-foreground",
      } satisfies Record<Tone, string>,
    },
  },
);

export const StatusBadge = ({
  status,
  label,
  className,
}: {
  readonly status: string;
  /** What to print, when it is not the status itself. */
  readonly label?: string;
  readonly className?: string;
}) => (
  <span className={cn(badge({ tone: toneOf(status) }), className)} data-tone={toneOf(status)}>
    {label ?? status}
  </span>
);
