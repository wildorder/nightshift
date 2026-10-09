/**
 * The last of a step's output, as text a reader can be shown inline (P16 D-07).
 *
 * Terminal colour codes and carriage-return redraws are dropped, so what is
 * kept is what a person would read, and trailing blank lines are trimmed so the
 * tail ends at the last thing the step said.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: an ANSI escape is a control character.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters dropped from a tail.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** An output, decoded and cleaned for reading, whole. */
export const readableOutput = (output: Uint8Array | string): string =>
  (typeof output === "string" ? output : new TextDecoder().decode(output))
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    // A progress line redrawn in place: only what it last said.
    .replace(/^.*\r/gm, "")
    .replace(CONTROL, "")
    .trimEnd();

/** At most the last `maxChars` characters of `text`, never splitting a surrogate pair. */
export const lastChars = (text: string, maxChars: number): string => {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const tail = text.slice(text.length - maxChars);
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
};

/** The last `maxChars` characters of an output, cleaned for reading. */
export const readableTail = (output: Uint8Array | string, maxChars: number): string => {
  // Only the end is read: room for every character at four bytes, and for the
  // colour codes and blank lines cleaning drops.
  const window = maxChars * 4 + 16_384;
  const end =
    typeof output === "string"
      ? output.slice(Math.max(0, output.length - window))
      : output.subarray(Math.max(0, output.length - window));
  return lastChars(readableOutput(end), maxChars);
};
