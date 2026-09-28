export const Json = ({ value, label }: { readonly value: unknown; readonly label?: string }) => (
  <section aria-label={label ?? "JSON"}>
    <pre className="overflow-auto rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  </section>
);
