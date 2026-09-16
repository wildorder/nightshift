/**
 * Opening the operator's browser.
 *
 * Answers whether it worked rather than throwing, because "it did not work" is
 * an ordinary outcome, not a failure: a headless machine, an SSH session, a
 * container. `nightshift login` prints the URL and keeps waiting, and the sign-in
 * completes from whatever browser the human does have.
 *
 * On macOS and Linux the URL is one argument of an `execFile` call with no shell
 * in between, so nothing in it can be interpreted as a command. On Windows the
 * opener *is* a shell builtin, and `openerFor` explains what that costs.
 */
import { execFile } from "node:child_process";

/** How to hand `url` to the platform's default handler. */
export interface OpenerInvocation {
  readonly command: string;
  readonly args: readonly string[];
  /** Windows only: pass `args` through verbatim, because we quoted them ourselves. */
  readonly windowsVerbatimArguments: boolean;
}

/**
 * The platform's "open this in the default handler" command, with the URL in
 * place.
 *
 * Windows is the one that needs care. `start` is a `cmd` builtin, so there is a
 * shell in the way whether we like it or not, and an authorization URL is full
 * of `&`, which `cmd` reads as a command separator. Node only quotes an argument
 * that contains whitespace or quotes, so left to itself it would hand `cmd` a
 * URL cut off at the first `&`, and the browser would open a request Cognito
 * rejects. So the URL is wrapped in double quotes here, `&` is literal inside a
 * quoted string, and `windowsVerbatimArguments` stops Node from quoting the
 * quotes. The `""` before it is `start`'s title argument: without it, the first
 * quoted string is taken as a window title and nothing opens.
 */
export const openerFor = (platform: NodeJS.Platform, url: string): OpenerInvocation => {
  if (platform === "darwin") {
    return { command: "open", args: [url], windowsVerbatimArguments: false };
  }
  if (platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "start", '""', `"${url}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: "xdg-open", args: [url], windowsVerbatimArguments: false };
};

export const openBrowser = async (
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> => {
  const { command, args, windowsVerbatimArguments } = openerFor(platform, url);
  return new Promise<boolean>((resolve) => {
    execFile(command, [...args], { windowsHide: true, windowsVerbatimArguments }, (error) => {
      resolve(error === null);
    });
  });
};
