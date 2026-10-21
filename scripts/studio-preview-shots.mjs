#!/usr/bin/env node
/**
 * Screenshots of the Studio's fixture preview (P20, S-04).
 *
 * Starts the preview dev server (`apps/studio`, `npm run preview:fixtures`),
 * waits for it, and captures a full-page PNG of the run page for every
 * scenario x viewport (desktop 1440x900, mobile 390x844) x theme (light, dark)
 * into docs/programs/p20-measurements/studio-review/, so a design can be
 * reviewed against realistic data in a real browser.
 *
 *   node scripts/studio-preview-shots.mjs
 *   node scripts/studio-preview-shots.mjs --scenario complete,sparse
 *   node scripts/studio-preview-shots.mjs --scenario complete --query "tab=overview&scope=x" --suffix overview
 *
 * Options:
 *   --scenario a,b     scenarios to capture (default: all of them)
 *   --query "k=v&..."  appended to the page URL (tab, scope, ...)
 *   --suffix name      added to the file name: <scenario>-<name>-<viewport>-<theme>.png
 *   --viewport a,b     desktop, mobile (default: both)
 *   --theme a,b        light, dark (default: both)
 *   --out dir          output directory (default: the studio-review folder)
 *
 * Chromium is installed with `npx playwright install chromium` when it is
 * missing. Exits non-zero when the server does not start, a page throws, or a
 * page that should render does not settle.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5174;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const SCENARIOS = ["complete", "sparse", "running", "failed", "error", "loading"];
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

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const scenarios = list(options.scenario, SCENARIOS, "scenario");
  const viewports = list(options.viewport, Object.keys(VIEWPORTS), "viewport");
  const themes = list(options.theme, THEMES, "theme");
  const out = resolve(ROOT, options.out ?? "docs/programs/p20-measurements/studio-review");
  const extra = (options.query ?? "").replace(/^[?&]/, "");
  await mkdir(out, { recursive: true });

  const { chromium } = await import("playwright");
  const server = startServer();
  let browser;
  const failures = [];
  try {
    await waitForServer(server);
    browser = await launch(chromium);
    for (const scenario of scenarios) {
      for (const viewport of viewports) {
        for (const theme of themes) {
          const name = `${[scenario, options.suffix, viewport, theme].filter(Boolean).join("-")}.png`;
          const context = await browser.newContext({
            viewport: VIEWPORTS[viewport],
            colorScheme: theme,
          });
          const page = await context.newPage();
          const thrown = [];
          page.on("pageerror", (error) => thrown.push(String(error)));
          try {
            const query = `scenario=${scenario}&theme=${theme}${extra === "" ? "" : `&${extra}`}`;
            await page.goto(`${ORIGIN}/preview.html?${query}`, { waitUntil: "load" });
            await settle(page, scenario);
            if (thrown.length > 0) throw new Error(`the page threw: ${thrown.join("; ")}`);
            await page.screenshot({ path: join(out, name), fullPage: true });
            console.log(`wrote ${join(out, name)}`);
          } catch (error) {
            failures.push(`${name}: ${error instanceof Error ? error.message : error}`);
            console.error(`FAILED ${name}: ${error}`);
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser?.close();
    server.stop();
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
