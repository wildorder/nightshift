/** A record as JSON, for the details a page does not lay out. */
export const Json = ({ value, label }: { readonly value: unknown; readonly label?: string }) => (
  <section aria-label={label ?? "JSON"}>
    <pre className="overflow-auto rounded-md border bg-muted p-3 font-mono text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  </section>
);
