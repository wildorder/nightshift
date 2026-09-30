export const SignInPage = ({
  onSignIn,
  problem,
}: {
  readonly onSignIn: () => void;
  readonly problem?: string | undefined;
}) => (
  <main className="mx-auto mt-24 max-w-sm rounded-xl border bg-card p-6 text-center text-card-foreground shadow-sm">
    <h1 className="mb-2 text-xl font-semibold">Nightshift Studio</h1>
    <p className="mb-4 text-sm text-muted-foreground">Sign in with your Nightshift account.</p>
    {problem === undefined ? null : (
      <p role="alert" className="mb-4 text-sm text-destructive">
        {problem}
      </p>
    )}
    <button
      type="button"
      className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      onClick={onSignIn}
    >
      Sign in
    </button>
  </main>
);

/** A local instance's tab with no token (D-P12-04): the way in is the printed URL. */
export const LocalStartPage = ({ signedOut = false }: { readonly signedOut?: boolean }) => (
  <main className="mx-auto mt-24 max-w-md rounded-xl border bg-card p-6 text-center text-card-foreground shadow-sm">
    <h1 className="mb-2 text-xl font-semibold">Nightshift Studio</h1>
    <p className="text-sm text-muted-foreground">
      {signedOut ? "Signed out of this tab. " : ""}This is a local instance. Open the Studio URL
      that <code>nightshift local</code> printed; it carries this machine's token.
    </p>
  </main>
);
