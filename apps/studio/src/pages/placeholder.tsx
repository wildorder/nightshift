/** Pages T3 … T5 fill; the routes exist so the shell's links resolve. */
export const Placeholder = ({ title }: { readonly title: string }) => (
  <section>
    <h1 className="text-xl font-semibold">{title}</h1>
    <p className="text-slate-600">Not built yet.</p>
  </section>
);
