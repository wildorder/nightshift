/**
 * Opening the operator's browser.
 *
 * Answers whether it worked rather than throwing, because "it did not work" is
 * an ordinary outcome, not a failure: a headless machine, an SSH session, a
 * container. `nightshift login` prints the URL and keeps waiting, and the sign-in
 * completes from whatever browser the human does have.
 *
 * The URL is handed to the platform opener as one argument of an `execFile`
 * call, never through a shell, so nothing in it can be interpreted as a command.
 * It is Nightshift's own URL rather than something a user typed, but a
 * shell-quoting bug in an authorization URL full of `&` and `%` would be found
 * the hard way.
 */
import { execFile } from "node:child_process";

/** The platform's "open this in the default handler" command. */
export const openerFor = (
  platform: NodeJS.Platform,
): { readonly command: string; readonly args: readonly string[] } => {
  if (platform === "darwin") return { command: "open", args: [] };
  // `start` is a `cmd` builtin, not a program. The empty string is `start`'s
  // title argument: without it, a quoted URL would be taken as the window title
  // and nothing would open.
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", ""] };
  return { command: "xdg-open", args: [] };
};

export const openBrowser = async (
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> => {
  const { command, args } = openerFor(platform);
  return new Promise<boolean>((resolve) => {
    execFile(command, [...args, url], { windowsHide: true }, (error) => {
      resolve(error === null);
    });
  });
};
