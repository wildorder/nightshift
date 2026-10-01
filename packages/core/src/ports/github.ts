/**
 * What the control plane asks GitHub, as the Nightshift App (P10, D-P10-02).
 *
 * `core` names the two questions and nothing about how they are answered:
 * `apps/api` implements this over the App's private key (T4); the offline
 * suites implement it with a table.
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
}
