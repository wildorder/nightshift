export const SignInPage = ({
  onSignIn,
  problem,
}: {
  readonly onSignIn: () => void;
  readonly problem?: string | undefined;
}) => (
  <main className="mx-auto mt-24 max-w-sm rounded border border-slate-200 bg-white p-6 text-center">
    <h1 className="mb-2 text-xl font-semibold">Nightshift Studio</h1>
    <p className="mb-4 text-sm text-slate-600">Sign in with your Nightshift account.</p>
    {problem === undefined ? null : (
      <p role="alert" className="mb-4 text-sm text-red-700">
        {problem}
      </p>
    )}
    <button
      type="button"
      className="rounded bg-slate-900 px-4 py-2 text-white hover:bg-slate-700"
      onClick={onSignIn}
    >
      Sign in
    </button>
  </main>
);
