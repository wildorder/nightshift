#!/usr/bin/env node
/**
 * Screenshots and layout checks of the Studio's fixture preview (P20, S-04).
 *
 * Starts the preview dev server (`apps/studio`, `npm run preview:fixtures`),
 * waits for it, and for every viewport (desktop 1440x900, mobile 390x844) x
 * theme (light, dark) captures a full-page PNG of:
 *   - the Overview tab of every scenario              <scenario>-overview-<viewport>-<theme>.png
 *   - the history scope of every scenario with one    <scenario>-history-<viewport>-<theme>.png
 *   - the evidence sheet open on the Consumed tile    complete-evidence-consumed-<viewport>-<theme>.png
 * into docs/programs/p20-measurements/studio-review/, and writes widths.json
 * beside them.
 *
 * A shot FAILS (exit 1) when the page scrolls sideways
 * (document.documentElement.scrollWidth > the viewport width) or, best effort,
 * when a text element is cut off by an overflow-clipping ancestor or truncated
 * with an ellipsis and carries no full-text `title` (itself or an ancestor).
 *
 *   node scripts/studio-preview-shots.mjs
 *   node scripts/studio-preview-shots.mjs --scenario complete,sparse --viewport mobile
 *   node scripts/studio-preview-shots.mjs --scenario complete --query "tab=status" --suffix status
 *
 * Options:
 *   --scenario a,b     scenarios to capture (default: all of them)
 *   --query "k=v&..."  capture one custom shot per scenario with this query instead of the set above
 *   --suffix name      with --query: the file name is <scenario>-<name>-<viewport>-<theme>.png
 *   --viewport a,b     desktop, mobile (default: both)
 *   --theme a,b        light, dark (default: both)
 *   --out dir          output directory (default: the studio-review folder)
 *
 * Chromium is installed with `npx playwright install chromium` when it is
 * missing. Exits non-zero when the server does not start, a page throws, a
 * page that should render does not settle, or a layout check fails.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5174;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const SCENARIOS = [
  "complete",
  "sparse",
  "running",
  "failed",
  "error",
  "loading",
  "partial-history",
  "running-history",
  "failed-history",
];
/** Scenarios whose run belongs to a completion history. */
const WITH_HISTORY = ["complete", "partial-history", "running-history", "failed-history"];
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};
const THEMES = ["light", "dark"];
const SETTLE_MS = 45_000;
const BOUNDED_MS = 4_000;

const parseArgs = (argv) => {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    options[arg.slice(2)] = value;
    i++;
  }
  return options;
};

const list = (value, all, what) => {
  if (value === undefined) return all;
  const chosen = value.split(",").filter(Boolean);
  const unknown = chosen.filter((name) => !all.includes(name));
  if (unknown.length > 0)
    throw new Error(`unknown ${what} ${unknown.join(", ")}; use ${all.join(", ")}`);
  return chosen;
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const startServer = () => {
  const child = spawn("npm", ["--workspace", "@nightshift/studio", "run", "preview:fixtures"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  return {
    log: () => log,
    exited: () => exited,
    stop: () => {
      if (exited) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    },
  };
};

const waitForServer = async (server) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exited()) throw new Error(`the preview server exited:\n${server.log()}`);
    try {
      const response = await fetch(`${ORIGIN}/preview.html`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new Error(`the preview server did not answer on ${ORIGIN} within 60s:\n${server.log()}`);
};

const launch = async (chromium) => {
  try {
    return await chromium.launch();
  } catch (error) {
    if (!/Executable doesn't exist|playwright install/i.test(String(error))) throw error;
    console.log("chromium is not installed; running `npx playwright install chromium`");
    const install = spawnSync("npx", ["playwright", "install", "chromium"], {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (install.status !== 0) throw new Error("`npx playwright install chromium` failed");
    return chromium.launch();
  }
};

const settle = async (page, scenario) => {
  if (scenario === "loading") {
    // The report never arrives; give the page a moment to show what it shows meanwhile.
    await sleep(BOUNDED_MS);
    return;
  }
  if (scenario === "error") {
    // The refusal should surface at once; a bounded wait, and the screenshot is taken either way.
    await page
      .waitForFunction(() => document.body.innerText.includes("Could not"), undefined, {
        timeout: BOUNDED_MS * 2,
      })
      .catch(() => {});
    await sleep(300);
    return;
  }
  await page.waitForFunction(
    () =>
      document.body.innerText.trim().length > 0 &&
      !document.body.innerText.includes("Building the report"),
    undefined,
    { timeout: SETTLE_MS },
  );
  await page.evaluate(() => document.fonts.ready);
  await sleep(500);
};

/** Runs in the page: what is clipped, and what is truncated, on the current layout. */
const inspectLayout = () => {
  const clipped = [];
  const truncated = [];
  const describe = (el) =>
    `${el.tagName.toLowerCase()}${el.dataset?.testid ? `[${el.dataset.testid}]` : ""} "${(el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60)}"`;
  const clips = (el) => {
    const style = getComputedStyle(el);
    return style.overflowX === "hidden" || style.overflowX === "clip";
  };
  const hasTitle = (el) => {
    for (let node = el; node !== null; node = node.parentElement)
      if (node.getAttribute("title")) return true;
    return false;
  };
  // SVG row labels are cut by hand with an ellipsis; the full text must be the group's <title>.
  for (const text of document.body.querySelectorAll("svg text")) {
    if (!(text.textContent ?? "").endsWith("…")) continue;
    if (text.parentElement?.querySelector(":scope > title")) truncated.push(describe(text));
    else clipped.push(`ellipsised SVG label without a <title>: ${describe(text)}`);
  }
  for (const el of document.body.querySelectorAll("*")) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim() !== ""))
      continue;
    if (el.closest(".sr-only")) continue;
    // Truncated by its own box (text-overflow: ellipsis or a clipped line).
    if (clips(el) && el.scrollWidth > el.clientWidth + 1) {
      if (hasTitle(el)) truncated.push(describe(el));
      else clipped.push(`truncated without a title: ${describe(el)}`);
      continue;
    }
    // Cut off by a clipping ancestor.
    for (
      let anc = el.parentElement;
      anc !== null && anc !== document.body;
      anc = anc.parentElement
    ) {
      if (!clips(anc)) continue;
      const box = anc.getBoundingClientRect();
      if (rect.right > box.right + 1 || rect.left < box.left - 1) {
        if (hasTitle(el)) truncated.push(describe(el));
        else clipped.push(`cut off by an overflow-hidden ancestor: ${describe(el)}`);
        break;
      }
    }
  }
  return {
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    clipped,
    truncatedWithTitle: truncated.length,
  };
};

/** The shots to take for one scenario: name part, query, and what to do on the page first. */
const shotsFor = (scenario, options) => {
  if (options.query !== undefined) {
    const extra = options.query.replace(/^[?&]/, "");
    return [{ label: options.suffix, query: extra }];
  }
  const shots = [{ label: "overview", query: "tab=overview" }];
  if (WITH_HISTORY.includes(scenario))
    shots.push({ label: "history", query: "tab=overview", history: true });
  if (scenario === "complete")
    shots.push({ label: "evidence-consumed", query: "tab=overview", evidence: "consumed" });
  return shots;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const scenarios = list(options.scenario, SCENARIOS, "scenario");
  const viewports = list(options.viewport, Object.keys(VIEWPORTS), "viewport");
  const themes = list(options.theme, THEMES, "theme");
  const out = resolve(ROOT, options.out ?? "docs/programs/p20-measurements/studio-review");
  await mkdir(out, { recursive: true });

  const { chromium } = await import("playwright");
  const server = startServer();
  let browser;
  const failures = [];
  const measured = [];
  try {
    await waitForServer(server);
    // An unbuilt workspace package makes the entry fail to transform; say so now, not after a 45s wait.
    const entry = await fetch(`${ORIGIN}/src/preview/main.tsx`);
    if (!entry.ok)
      throw new Error(
        `the preview entry does not compile (${entry.status}); run \`npm run build\` first:\n${server.log()}`,
      );
    browser = await launch(chromium);
    for (const scenario of scenarios) {
      for (const shot of shotsFor(scenario, options)) {
        for (const viewport of viewports) {
          for (const theme of themes) {
            const name = `${[scenario, shot.label, viewport, theme].filter(Boolean).join("-")}.png`;
            const context = await browser.newContext({
              viewport: VIEWPORTS[viewport],
              colorScheme: theme,
            });
            const page = await context.newPage();
            const thrown = [];
            page.on("pageerror", (error) => thrown.push(String(error)));
            try {
              const base = `scenario=${scenario}&theme=${theme}${shot.query ? `&${shot.query}` : ""}`;
              await page.goto(`${ORIGIN}/preview.html?${base}`, { waitUntil: "load" });
              await settle(page, scenario);
              if (shot.history) {
                const value = await page
                  .getByLabel("Scope")
                  .locator("option")
                  .evaluateAll((os) =>
                    os.map((o) => o.value).find((v) => v.startsWith("history:")),
                  );
                if (value === undefined) throw new Error("the scenario has no completion history");
                await page.goto(
                  `${ORIGIN}/preview.html?${base}&scope=${encodeURIComponent(value)}`,
                  { waitUntil: "load" },
                );
                await settle(page, scenario);
              }
              if (shot.evidence) {
                await page.locator(`[data-tile="${shot.evidence}"]`).click();
                await page.getByRole("dialog").waitFor({ timeout: BOUNDED_MS * 2 });
                await sleep(600);
              }
              if (thrown.length > 0) throw new Error(`the page threw: ${thrown.join("; ")}`);
              const layout = await page.evaluate(inspectLayout);
              const width = VIEWPORTS[viewport].width;
              measured.push({
                image: name,
                viewport,
                theme,
                viewportWidth: width,
                scrollWidth: layout.scrollWidth,
                clientWidth: layout.clientWidth,
                clipped: layout.clipped,
                truncatedWithTitle: layout.truncatedWithTitle,
              });
              await page.screenshot({ path: join(out, name), fullPage: true });
              console.log(`wrote ${join(out, name)} (scrollWidth ${layout.scrollWidth}/${width})`);
              if (layout.scrollWidth > width)
                throw new Error(
                  `the page scrolls sideways: scrollWidth ${layout.scrollWidth} > ${width}`,
                );
              if (layout.clipped.length > 0)
                throw new Error(`clipped text: ${layout.clipped.slice(0, 5).join(" | ")}`);
            } catch (error) {
              failures.push(`${name}: ${error instanceof Error ? error.message : error}`);
              console.error(`FAILED ${name}: ${error}`);
            } finally {
              await context.close();
            }
          }
        }
      }
    }
  } finally {
    await browser?.close();
    server.stop();
    if (measured.length > 0) {
      measured.sort((x, y) => x.image.localeCompare(y.image));
      await writeFile(join(out, "widths.json"), `${JSON.stringify(measured, null, 2)}\n`);
    }
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} screenshot(s) failed:\n${failures.join("\n")}`);
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
