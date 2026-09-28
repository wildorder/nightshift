const TONE: Readonly<Record<string, string>> = {
  succeeded: "bg-green-100 text-green-800",
  verified: "bg-green-100 text-green-800",
  integrated: "bg-green-100 text-green-800",
  passed: "bg-green-100 text-green-800",
  running: "bg-blue-100 text-blue-800",
  verifying: "bg-blue-100 text-blue-800",
  implemented: "bg-blue-100 text-blue-800",
  pending: "bg-slate-100 text-slate-700",
  queued: "bg-slate-100 text-slate-700",
  deferred: "bg-amber-100 text-amber-800",
  parked: "bg-amber-100 text-amber-800",
  blocked: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-800",
  verification_failed: "bg-red-100 text-red-800",
  cancelled: "bg-red-100 text-red-800",
  interrupted: "bg-red-100 text-red-800",
  discarded: "bg-red-100 text-red-800",
  findings_raised: "bg-amber-100 text-amber-800",
};

export const Status = ({ value }: { readonly value: string }) => (
  <span
    className={`inline-block rounded px-1.5 py-0.5 font-mono text-xs ${TONE[value] ?? "bg-slate-100 text-slate-700"}`}
  >
    {value}
  </span>
);
