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

/** A pull request as GitHub states it (P25). */
export interface GitHubPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  /** The commit the pull request's head branch is at. */
  readonly headSha: string;
}

/**
 * What the GitHub writer does with pull requests (P25, D-P25-11, D-P25-12),
 * with a token that asks for pull requests and contents write: minted only in
 * the publisher Lambda, like `writeToken`.
 */
export interface GitHubPullRequests {
  /** Creates `refs/heads/<branch>` at `sha`; a branch already at `sha` is fine. */
  createBranch(
    installationId: number,
    repository: string,
    branch: string,
    sha: string,
  ): Promise<void>;
  /** Opens one; an open one from the same head branch is answered instead. */
  open(
    installationId: number,
    repository: string,
    request: {
      readonly head: string;
      readonly base: string;
      readonly title: string;
      readonly body: string;
    },
  ): Promise<GitHubPullRequest>;
  get(
    installationId: number,
    repository: string,
    number: number,
  ): Promise<GitHubPullRequest | undefined>;
  /** Comments, then closes it unmerged. */
  close(installationId: number, repository: string, number: number, comment: string): Promise<void>;
  /**
   * Merges it with a merge commit, only while its head is `sha`. Answers whether
   * GitHub merged it, and why not when it did not.
   */
  merge(
    installationId: number,
    repository: string,
    number: number,
    sha: string,
  ): Promise<{ readonly merged: true } | { readonly merged: false; readonly detail: string }>;
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
   * Whether `ancestor` is contained in `descendant` (GitHub's compare answers
   * `identical` or `ahead`); `undefined` when GitHub does not know one of them.
   * Optional: a plane without it never wakes a line for main (P25, D-P25-06).
   */
  contains?(
    installationId: number,
    repository: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean | undefined>;
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
  /** P25: the GitHub writer's pull requests; absent where nothing opens them. */
  readonly pullRequests?: GitHubPullRequests;
}

/** `owner/name` from the forms a contract's `repository.url` takes. */
export const repositoryNameOf = (url: string): string | undefined => {
  const match =
    /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url) ??
    /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url);
  return match?.[1] === undefined || match[2] === undefined ? undefined : `${match[1]}/${match[2]}`;
};
