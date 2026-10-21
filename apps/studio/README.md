# @nightshift/studio

The Nightshift Studio (P11): a hosted client of the control plane and nothing
else (A-15a). It is served from CloudFront at `studio.<stage>.nightshift.wildorder.dev`
and reads and writes only through the routes the API serves, as the CLI does.

Running it from this repository (`npm run studio`) is for developing the Studio
itself (D-P11-01): the same build against the same control plane, signed in
through the `dev` stage's Studio client, which alone registers the localhost
callback. It is not a product mode.

## Fixture preview and screenshots

The run page can be designed and reviewed against realistic data without a
control plane. The preview mounts the real `App` over in-memory stores seeded
by a scenario (`src/preview/scenarios.ts`); it is a dev server only, from its
own Vite config, so `npm run build` (and `dist/`) never includes it.

```sh
npm --workspace @nightshift/studio run preview:fixtures   # http://127.0.0.1:5174/preview.html
```

Open `/preview.html?scenario=<name>&theme=<light|dark>`. Any other query
parameter goes to the run page, so `&tab=work` opens that tab.

| scenario   | what it is                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `complete` | a finished run: 2 strands, 4 jobs, rework, an examination and an arbitration, an integration conflict, measurement per attempt (one partial), lifecycle observations, a machine, a verdict and a completion history across 3 runs |
| `sparse`   | a legacy run: routes with usage, no measurement summaries, no lifecycle events, unrated, no completion history  |
| `running`  | a run in progress: open work, a node waiting on capacity, partial summaries, no verdict                          |
| `failed`   | a run that failed: one job failed after two attempts, nothing succeeded                                          |
| `error`    | the report's reads are refused                                                                                   |
| `loading`  | the report's reads never answer                                                                                  |

Ids and the clock are deterministic, so a scenario looks the same every time.

`scripts/studio-preview-shots.mjs` starts that server and writes a full-page PNG
per scenario x viewport (`desktop` 1440x900, `mobile` 390x844) x theme to
`docs/programs/p20-measurements/studio-review/`:

```sh
node scripts/studio-preview-shots.mjs                                  # everything
node scripts/studio-preview-shots.mjs --scenario complete,sparse --viewport desktop --theme light
node scripts/studio-preview-shots.mjs --scenario complete --query "tab=work" --suffix work
# -> complete-work-desktop-light.png, ...
```

It uses Playwright (a dev dependency, never imported by the Studio) and runs
`npx playwright install chromium` when the browser is missing. It exits non-zero
if the server does not start, a page throws, or a page does not finish building
its report (`error` and `loading` are captured after a bounded wait instead).
