/**
 * The rule that keeps the Studio restylable from one file (P13, D-P13-02):
 * no colour anywhere in `src/` except `theme.css` and `components/ui/`.
 */
const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const UTILITY =
  "bg|text|border|ring|fill|stroke|from|to|via|outline|divide|shadow|accent|caret|decoration|placeholder|ring-offset";

const RULES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  {
    name: "a Tailwind palette colour",
    pattern: new RegExp(`\\b(?:${UTILITY})-(?:(?:${PALETTE})-\\d{2,3}|white|black)\\b`),
  },
  {
    name: "a hex colour",
    pattern: /(?<![\w/&#])#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?\b/,
  },
  { name: "a colour function", pattern: /\b(?:oklch|oklab|rgba?|hsla?|lab|lch|color-mix)\(/ },
  { name: "an arbitrary colour value", pattern: /-\[(?:#|oklch|rgb|hsl|color)/ },
];

/** Where colours may live. Paths are relative to `src/`, with forward slashes. */
export const EXEMPT = (path: string): boolean =>
  path === "theme.css" || path.startsWith("components/ui/");

export interface ColourFinding {
  readonly path: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

/** Every colour in `text`, one finding per line and rule. */
export const findColours = (path: string, text: string): readonly ColourFinding[] => {
  if (EXEMPT(path)) return [];
  const findings: ColourFinding[] = [];
  text.split("\n").forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ path, line: index + 1, rule: rule.name, text: line.trim().slice(0, 120) });
      }
    }
  });
  return findings;
};
