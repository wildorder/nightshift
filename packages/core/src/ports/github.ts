/**
 * What the control plane asks GitHub, as the Nightshift App (P10, D-P10-02,
 * D-P10-22).
 *
 * `core` names the questions and nothing about how they are answered:
 * `apps/api` implements this over the App's private key; the offline suites
 * implement it with a table.
 */

export interface GitHubAppIdentity {
  readonly slug: string;
  /** Where a customer installs the App on their repositories. */
  readonly installUrl: string;
}

export interface GitHubInstallationFacts {
  /** The account the App is installed on. */
  readonly account: string;
  /** `owner/name`, every repository the installation grants. */
  readonly repositories: readonly string[];
}

export interface GitHubAppClient {
  app(): Promise<GitHubAppIdentity>;
  /** The installation's facts, or `undefined` when GitHub knows no such installation of this App. */
  installation(installationId: number): Promise<GitHubInstallationFacts | undefined>;
  /** The branch's head at GitHub, as the installation sees it; `undefined` for no such branch. */
  branchHead(
    installationId: number,
    repository: string,
    branch: string,
  ): Promise<string | undefined>;
  /**
   * A short-lived installation token for reading `repositories` (a machine's
   * clone, D-P10-02). Contents read and nothing else; the publisher mints its
   * own, with write, in T4.
   */
  readToken(
    installationId: number,
    repositories: readonly string[],
  ): Promise<{ readonly token: string; readonly expiresAt: string }>;
  /**
   * The publisher's token (D-P10-22): contents write on the one repository a
   * publication intent names, minted in the publisher Lambda and nowhere else.
   */
  writeToken(
    installationId: number,
    repository: string,
  ): Promise<{ readonly token: string; readonly expiresAt: string }>;
}

/** `owner/name` from the forms a contract's `repository.url` takes. */
export const repositoryNameOf = (url: string): string | undefined => {
  const match =
    /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url) ??
    /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url);
  return match?.[1] === undefined || match[2] === undefined ? undefined : `${match[1]}/${match[2]}`;
};
