# Program P13 — Studio UI

| Field | Value |
|-------|-------|
| Program ID | `p13-studio-ui` |
| Project ID | `nightshift` |
| Base branch | `main` |
| Program branch | `program/p13-studio-ui` |
| Source stage | none: the owner's direction of 2026-09-29 (§3.1), after P12 |
| Status | **Built 2026-09-29** (T1 … T5, §13); Studio redeployed; awaiting the owner's trial (SC-P13-13) and their word on the build decisions (§13). |
| Depends on | P11 (the Studio and its pages), P12 (the local instance, the token session) |
| Blocking decisions | none: D-P13-01 … D-P13-11 ratified |

This contract is the stable authority for P13. The implementation plan may be
revised continuously; this contract may not be revised to make an implementation
pass. Amend it only through a human decision recorded in §12.

## 1. Objective

Give the Studio a real application UI: a SaaS dashboard shell (sidebar, project
switcher, user menu, breadcrumbs) and pages built from one component library,
with every visual decision (colour, radius, type, the colour of a status) in
**one theme file**, so the Studio can be re-styled later by editing that file
and nothing else. The pages keep what they show and what they write (D-P11-10);
this program changes how they look and how they are laid out, not what they do.

**What P13 is not.** No new data, route or write. No change to the control plane,
the session, or the local instance. Not the marketing site (a separate
repository).

### What exists today

- **Fourteen `.tsx` files, about 300 `className` lists, raw Tailwind palette
  classes in eleven of them** (`text-slate-600` ×28, `text-slate-500` ×27,
  `border-slate-200` ×17, `bg-white` ×14, `text-red-800`, `text-amber-800`, …).
  A restyle today touches all eleven, by hand.
- **`src/index.css` is one line**, `@import "tailwindcss"`: no tokens, no dark
  mode.
- **Status colours live in one component** (`components/status.tsx`), as a map
  from status to raw classes. It is the one place already done right in intent.
- **The layout is a top bar over one scrolling column.** The run page stacks
  eleven sections in a single scroll: report, strands, jobs, tree, timeline,
  checkpoints, artifacts, decision graph.
- **The Studio's `tsconfig` inherits `moduleResolution: nodenext`** from the base,
  so every relative import carries `.js`; shadcn's generated code imports
  `@/lib/utils` with no extension and needs `bundler` resolution.
- **Tests find elements by role and text** (Testing Library over the memory
  stores), which survives a markup change well.

## 2. Environment and human prerequisites

| # | Prerequisite | Status |
|---|--------------|--------|
| H-P13-01 | Ratify D-P13-01 … D-P13-11 | **satisfied 2026-09-29** |

**Explicitly not required.** No AWS change. The hosted Studio is redeployed at the
end (the Studio stack only).

## 3. Decisions

### 3.1 The owner's direction, 2026-09-29

| # | Question | Answer |
|---|----------|--------|
| Q1 | A template for layout and components with easy Tailwind styling | **shadcn/ui** |
| Q2 | Styling | **Global, template-style theming**: re-styling everything later must not mean inline styles or touching hundreds of files |
| Q3 | What is looked at most | **A program's status**: what landed, what waits on the owner, what failed, what it cost. On the run's first tab, and on each program's card |
| Q4 | The execution tree | **A horizontal tree to trace what happened**, with status markers on each node, and a decision's reach made visible |
| Q5 | A node's detail | **Its objective and what it had to pass**, in a panel under the tree |

### 3.2 Ratified decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D-P13-01 | **shadcn/ui, copied into `apps/studio/src/components/ui/`**, on Radix primitives and `lucide-react` icons, configured by `components.json` (style `new-york`, base colour neutral, CSS variables on). Components are added with the shadcn CLI and kept as generated, so a later `shadcn diff` shows upstream changes. | Q1. The code lives in the repository and is ours to read and change; it is built on Tailwind 4 and Radix, which the Studio's stack already fits. |
| D-P13-02 | **One theme file, semantic tokens only.** `src/theme.css` holds every design decision as CSS variables: shadcn's semantic set (`--background`, `--foreground`, `--card`, `--primary`, `--muted`, `--muted-foreground`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--radius`, the sidebar and chart sets), plus Nightshift's own status set (D-P13-03) and the font stacks, for `:root` and `.dark`, mapped into Tailwind through `@theme inline`. Everything else uses semantic utilities (`bg-background`, `text-muted-foreground`, `border-border`, `bg-primary`) or a component's variant (`<Button variant="outline">`, `<StatusBadge status=…>`). **Raw palette classes, hex or `oklch` literals, and arbitrary colour values are forbidden outside `theme.css` and `components/ui/`**, held by a test that scans `src/`. | Q2. A restyle is an edit to `theme.css`; a new theme is a new variable block. The test is what keeps it true after the first week. |
| D-P13-03 | **Status is a token, not a colour.** Tones `success`, `warning`, `danger`, `info`, `neutral`, each a foreground and a background variable in `theme.css`; one `StatusBadge` whose `cva` variants are the tones, and one table in `lib/status.ts` mapping every domain status (node, run, route, verification, examination, strand outcome, decision place) to a tone. Nothing else decides what colour a status is. | The Studio's densest pages are mostly statuses. One table means "verification_failed is danger" is said once, and a new status the contracts add is one row. |
| D-P13-04 | **Light and dark themes from day one, following the system, with a toggle** in the user menu, remembered in `localStorage`. The same tokens, a second block. | Cheap when tokens are the only source of colour, and the thing that proves they are; developers expect it. |
| D-P13-05 | **The shell is shadcn's collapsible-sidebar layout**: a project switcher at the top of the sidebar (the "team switcher" pattern, over `project.list`), navigation (Projects, the current project's Runs, Settings), the user and sign-out in the sidebar footer, and a header with breadcrumbs (project › program › run › decision). On a narrow screen the sidebar is a sheet. | Q1's SaaS layout, and the standard one: a visitor recognises it at once. |
| D-P13-06 | **The run page becomes tabs**: *Status* (the program status of D-P13-09 first, *waiting on you* given the most weight; then rulings, criteria, prerequisites, usage and cost, corrections), *Graph* (D-P13-10), *Work* (strands and jobs as a list; a job opens in a side sheet with the detail of D-P13-11), *Timeline*, *Decisions*, *Artifacts*. The live indicator and the run's status stay in the header on every tab. The tab is in the URL (`?tab=`), so a link opens where it was. | Eleven stacked sections is the page's biggest problem; tabs are how dense run pages in this category read (CI providers, the hosted agent consoles). Status first, because it answers the question the page is opened for (Q3). |
| D-P13-07 | **Tables are shadcn's data table on TanStack Table** for the runs list, artifacts and usage: sortable columns, a status filter on runs. Everything else uses `Card`, `Badge`, `Tabs`, `Sheet`, `Table`, `Button`, `Input`, `Select`, `Dialog`, `Tooltip`, `Skeleton`, `DropdownMenu`, `Breadcrumb`, `Sidebar`, `Separator`, `ScrollArea`. | TanStack Table sits beside the TanStack Query already there; the rest is the smallest set that covers the pages. |
| D-P13-09 | **A program status, computed once and shown twice.** `programStatus(report)` in `core` (beside `gatherReport`) answers: strands or jobs landed and verified; what waits on the owner, each with its reason (an unmet prerequisite, a parked or blocked strand, a blocking finding, a failure that exhausted its retries); what failed; spend against the budget, estimated and unpriced marked. The run's *Status* tab leads with it, and each program's card on the project page shows it for that program's latest run. The project page therefore reads one report per program. | Q3. One computation, so the card and the tab never disagree; in `core`, so the CLI's report can use it too. At the owner's scale a report per program is cheap; a cached summary is the later fix if it is not. |
| D-P13-10 | **The run graph: a horizontal tree in React Flow (`@xyflow/react`), laid out left to right by `elkjs`.** The program node, then its strands in `dependsOn` order (dependency edges drawn), then each strand's jobs; an unplanned run's jobs hang from the root. Each node is a Nightshift component styled by the theme's tokens: its status, and markers for *decision* (with a count, opening the decision), *needs you*, *retried* (count), *examined* (with any finding), *landed* (the commit). Hovering or selecting a decision lights two sets, distinguished: **what it produced** (the recorded `produced` commits and the job that landed each) and **what was built after it on top of it** (the node's descendants, and the strands that depend on its strand), labelled "built after", never "caused by". | Q4. React Flow's nodes are ordinary React components, so the theme applies unchanged. The two-set highlight is what the record can honestly show: A-47 and the owner's P9 direction rule out computing a decision's cone, and the graph must not imply one. |
| D-P13-11 | **A node's detail opens in a panel docked under the graph**, resizable, updated in place as another node is selected; the same detail opens as a side sheet from the list views. It shows: **what it had to do** (the Job Contract's objective and acceptance; for a strand, its acceptance and the program's success criteria it claims, each met or not), **what was checked** (each verification step: pass or fail, command, duration, log), then status, attempts and the route of each, examination findings and rulings, the decisions made on it, and the commit it landed. | Q5. Under, not beside: a horizontal tree grows in width, which a side panel would take, and the graph stays in view while the detail is read. Acceptance is prose written at delegation and is not scored item by item; verification is what "passed" means, so the two are shown as what they are. |
| D-P13-08 | **The Studio resolves modules as a bundler does.** `apps/studio/tsconfig.json` sets `moduleResolution: bundler`, `module: esnext` and `paths: { "@/*": ["./src/*"] }`, with the matching Vite alias; relative imports lose their `.js`. Nothing outside `apps/studio` changes. | shadcn's code is written for it, and the Studio is a Vite app with `noEmit`, never run by Node. Keeping `nodenext` would mean editing every generated file. |

### Non-guarantees

- **Not a design system for the other apps.** The CLI prints text and the site is
  its own repository.
- **Not pixel-perfect across browsers.** The evergreen browsers shadcn supports.

## 4. Design

### 4.1 Where styling lives

```text
src/theme.css            every token, :root and .dark; @theme inline maps them to Tailwind
src/index.css            @import "tailwindcss"; @import "tw-animate-css"; @import "./theme.css"; base layer only
src/components/ui/*      shadcn components: the only place component-level classes are composed
src/components/*         Nightshift's own composites (StatusBadge, JsonView, RunHeader…), semantic utilities only
src/lib/status.ts        domain status → tone, the one table
src/pages/*              layout and composition; semantic utilities and component variants only
```

A restyle edits `theme.css`. A new component look edits one file in
`components/ui/`. A new status is one row in `lib/status.ts`. The guard test
(D-P13-02) fails a build that puts a colour anywhere else.

### 4.2 Tokens beyond shadcn's

```css
--status-success / --status-success-foreground
--status-warning / --status-warning-foreground
--status-danger  / --status-danger-foreground
--status-info    / --status-info-foreground
--status-neutral / --status-neutral-foreground
--font-sans, --font-mono
```

## 5. Scope

### In scope

shadcn setup and the components in D-P13-07; `theme.css` with both themes; the
guard test; `StatusBadge` and the status table; the sidebar shell, project
switcher, user menu with the theme toggle, breadcrumbs; every page rebuilt on the
components (projects, project, project settings, organisation settings, run,
decision, sign-in and the local start page); the run page's tabs and job sheet;
the data tables; the as-built; a Studio redeploy.

### Out of scope

- New data or writes; charts beyond what the usage table shows.
- Computing a decision's causal reach (A-47): the graph shows only what the record holds.
- The marketing site.
- A component catalogue (Storybook) or visual-regression service.

## 6. Success criteria

- **SC-P13-01** No raw palette class, colour literal or arbitrary colour value
  appears in `apps/studio/src` outside `theme.css` and `components/ui/`; the guard
  test fails on one (with a negative fixture).
- **SC-P13-02** Changing `--primary`, `--radius` and one status tone in
  `theme.css` alone changes the whole Studio: proven by a test that renders the
  run page under an overridden theme and asserts the computed styles follow.
- **SC-P13-03** Light and dark themes both render every page; the toggle switches
  and is remembered; the system preference is the default.
- **SC-P13-04** The shell: sidebar with project switcher, navigation, user menu and
  sign-out; breadcrumbs on every page below Projects; the sidebar collapses, and is
  a sheet on a narrow viewport.
- **SC-P13-05** The run page's tabs, each reachable by `?tab=`; a job opens in a
  sheet with its agents, routes, verifications and examinations; the live
  indicator on every tab.
- **SC-P13-06** Runs, artifacts and usage are data tables; runs sort by start and
  filter by status.
- **SC-P13-10** Each program's card and the run's *Status* tab show the same
  program status from `programStatus` (landed, waiting on you with reasons,
  failed, spend against budget), proven over the P7 … P9 fixtures.
- **SC-P13-11** The run graph lays out the P6 tree fixture left to right with its
  dependency edges; each node shows its status and markers; selecting a decision
  lights what it produced and what was built after it as two distinct sets, and
  never marks a node outside those.
- **SC-P13-12** Selecting a node opens its detail under the graph with its
  objective, acceptance, verification steps and the rest of D-P13-11; a strand's
  shows its claimed success criteria, met or not.
- **SC-P13-07** Every P11 and P12 Studio test passes, with changes only to how an
  element is found where the markup changed, never to what is asserted; listed in
  the as-built.
- **SC-P13-08** `npm run verify` green on both CI legs; the hosted Studio
  redeployed and `studio:smoke` green.

**Exit gate**

- **SC-P13-13** The owner's own: the hosted or local Studio, both themes, a live
  run followed through its tabs, and one restyle made by editing `theme.css` alone.

## 7. Deterministic verification

```text
npm run verify
npm run check:architecture
npm run local:e2e
```

From a developer machine: `npm run deploy` (the Studio stack), `npm run
studio:smoke`.

## 8. Constraints

- The pages' data, routes and writes are unchanged (D-P11-10).
- Every dependency pinned exactly (AR-6); the Studio's layer-table row unchanged.
- No inline `style` for colour, spacing or type; `style` only for values computed
  at run time (a progress width).
- Generated `components/ui/` files are edited only when a component's shape must
  change, never to set a colour (that is `theme.css`'s).

## 9. Permissions and forbidden actions

Permitted: editing `apps/studio`, the root scripts it needs, and the documents;
deploying the Studio stack; running the suites.

Forbidden:

- Weakening a P11 or P12 assertion.
- A colour outside `theme.css` and `components/ui/`.
- Changing what a page reads or writes.

## 10. Tasks

| Task | Title | Depends on | Needs |
|------|-------|------------|-------|
| T1 | The foundation: bundler resolution and `@/`, shadcn init, `theme.css` with both themes and the status tokens, the components of D-P13-07, `StatusBadge` and `lib/status.ts`, the guard test | — | — |
| T2 | The shell: sidebar, project switcher, navigation, user menu with sign-out and the theme toggle, breadcrumbs, the narrow-screen sheet | T1 | — |
| T3 | Projects, project, settings, sign-in and local start pages on the components; the runs data table | T2 | — |
| T4 | The run page's tabs, `programStatus` and the Status tab and program cards, the job sheet, the timeline, the artifacts and usage tables; the decision page | T2 | — |
| T4b | The run graph (React Flow, elkjs), its markers and the decision highlight; the node detail panel | T4 | — |
| T5 | The restyle proof (SC-P13-02), both themes across every page, the as-built, the Studio redeploy | T3, T4b | AWS |

```text
T1 ── T2 ──┬── T3 ─────────┐
           └── T4 ── T4b ──┴── T5
```

## 11. Risks

| Risk | Handling |
|------|----------|
| shadcn's generated code fights the repository's lint (Biome) | Biome's formatter runs over it once on add; lint rules that the generated code trips are overridden for `components/ui/` only, and listed |
| The guard test is too blunt and flags a legitimate class | It matches colour utilities by pattern (`(bg|text|border|ring|fill|stroke|from|to|via)-(slate|gray|zinc|…)-\d+`, `#hex`, `oklch(`, `[…]` colour values); anything else passes |
| Rebuilt pages silently drop a field the old one showed | SC-P13-07: the P11 assertions are kept verbatim, and they assert the fields |
| Dark mode reveals a hard-coded colour in a generated component | The guard excludes `components/ui/` by design, so each such file is checked once by eye in T5 and noted |

## 12. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-09-29 | **Built.** T1 … T5 on `program/p13-studio-ui`; `npm run verify` green under Node 24 (3,309 tests, 58 of them the Studio's); the Studio redeployed. The build decisions of §13 are provisional until the owner ratifies or reverses them. | Agent, for human ratification |
| 2026-09-29 | **Contract ratified**, D-P13-01 … D-P13-11, as written. | **Human** |
| 2026-09-29 | Revised with the owner: program status on the run's first tab and each program's card (D-P13-09), the horizontal run graph with a decision's recorded reach (D-P13-10), the node detail docked under the graph (D-P13-11); D-P13-06's first tab renamed *Status*. | Agent, from the owner's direction |
| 2026-09-29 | Contract drafted from the owner's direction (§3.1) and the Studio's code: eight decisions proposed for ratification. | Agent, for human ratification |

## 13. As built

Built 2026-09-29 on `program/p13-studio-ui`, T1 … T5 in one sitting.

### Task states

| Task | State | Notes |
|------|-------|-------|
| T1 | **done** | shadcn/ui in `components/ui/` (22 components); `theme.css` with both themes and the status tones; `lib/status.ts` and `StatusBadge`; the theme guard with a migration ratchet, now empty; bundler resolution and `@/` |
| T2 | **done** | the sidebar shell, project switcher, navigation, account menu with theme and sign-out, breadcrumbs |
| T3 | **done** | `programStatus` in `core`; each program's card shows its latest run's status; the runs data table with a status filter; every page but the run and decision pages on the components |
| T4 | **done** | the run page as six tabs in the URL; the job sheet; the artifacts data table; the decision page |
| T4b | **done** | the run graph, its markers, a decision's two sets, the node detail beneath |
| T5 | **done** | the restyle proof, both themes on every page, a look at a seeded run in light and dark, this as-built, the redeploy |

### What was proven, and where

| SC | State | By |
|----|-------|----|
| SC-P13-01 | met | `src/theme-guard.test.ts`: no colour in `src/` outside `theme.css`, the theme's own tests and `components/ui/`; its negative fixtures catch a palette class, `bg-white`, a hex, a colour function and an arbitrary value |
| SC-P13-02 | met | `src/theme-restyle.test.ts`: Tailwind's compiler over the real stylesheet; every utility compiles to a theme variable; a changed primary, radius and danger tone in `theme.css` alone change the output and leave every utility rule byte-identical |
| SC-P13-03 | met | `src/pages/themes.test.tsx` (six pages × two themes); `components/shell.test.tsx` (the toggle, remembered, the system default) |
| SC-P13-04 | met | `components/shell.test.tsx`, `app.test.tsx`: the switcher, the account menu and sign-out, the breadcrumbs, the collapse |
| SC-P13-05 | met | `pages/run.test.tsx`: each tab by its trigger; a job's sheet with its agents, verification and log; the live indicator |
| SC-P13-06 | met | `pages/project-status.test.tsx`: the runs table filters by status; sorted by start |
| SC-P13-07 | met | every P11 and P12 Studio assertion kept; the changes are listed below |
| SC-P13-08 | met | `npm run verify` green; the Studio redeployed and `studio:smoke` green |
| SC-P13-10 | met | `packages/core/src/report/status.test.ts`; `pages/project-status.test.tsx` (the card) and the Status tab over the same function |
| SC-P13-11 | met | `lib/run-graph.test.ts` (the model, the markers, the two sets and that an unrelated strand stays unmarked); `components/run/run-graph.test.tsx` (drawn in jsdom, a decision chosen, the marks) |
| SC-P13-12 | met | `run-graph.test.tsx`: a job's objective, acceptance and verification beneath the graph; a strand's claimed success criteria |
| SC-P13-13 | **the owner's** | below |

### Build decisions, provisional until the owner ratifies or reverses them

1. **dagre, not elkjs, lays the graph out.** `elkjs` is EPL-2.0 or GPL; bundling
   it into the Studio's served JavaScript is distribution under the EPL, with
   notice and source duties in an Apache-2.0 repository. `@dagrejs/dagre` (MIT)
   does the same layered left-to-right layout, synchronously. D-P13-10 named
   elkjs; this departs from it.
2. **The Studio turns `exactOptionalPropertyTypes` off in its own tsconfig.**
   Radix's types are not written for it, and shadcn's generated components fail
   it; the rule stays on for every other package, where a missing field and an
   `undefined` one mean different things. The alternative was editing generated
   files, which D-P13-01 rules out.
3. **Existing relative imports keep their `.js`.** D-P13-08 said they would lose
   it; bundler resolution accepts both, and removing them touched every file for
   nothing.
4. **Four lint rules are off for `components/ui/` only**: two accessibility
   rules in the breadcrumb, a hook-dependency rule and a cookie rule in the
   sidebar, all in shadcn's generated code. Biome now parses Tailwind's CSS
   directives (`css.parser.tailwindDirectives`).
5. **The `cn` helper is shadcn's own package** (`shadcn-ui/cn`, 0.4.0), which the
   current CLI uses in place of `clsx` plus `tailwind-merge`; pinned exactly.
6. **The guard exempts the theme's own tests (`theme-*.ts`)** besides
   `theme.css` and `components/ui/`, because the restyle proof must name colours;
   a file merely named like the theme is not exempt (tested).
7. **The restyle proof compiles CSS rather than reading computed styles**, since
   jsdom does not run Tailwind; `@tailwindcss/node` is a dev dependency.
8. **The graph tab loads on demand**, splitting React Flow and dagre (276 kB,
   89 kB gzipped) out of the main bundle.
9. **Graph nodes are 240 × 112**, found by looking at a seeded run: 84 clipped a
   two-line label into the marker row.
10. **`mountStudio` takes `string | MountOptions`**, and that union defeats
    TypeScript 7's inference of an inline `at: (f) => …`; three tests annotate
    `Fixtures`. The proper fix is one options shape for every caller, left for
    when the test helper is next changed.

### What changed in earlier programs' suites, and why

Nothing that is asserted changed; only where it is found.

- `app.test.tsx`: the project switcher and sign-out are found in their menus.
- `pages/run.test.tsx`: each assertion clicks into the tab or the job sheet that
  now holds it (D-P13-06, D-P13-11); the live test opens the Timeline and Work
  tabs.
- `test-setup.ts` gains `matchMedia`, `ResizeObserver` and pointer capture for
  jsdom, which Radix and the sidebar need.

### For the owner's trial (SC-P13-13)

1. Open the hosted Studio, or `nightshift local`. Try light, dark and system from
   the account menu.
2. Open a project: each program's card leads with its latest run's status.
3. Open a run: *Status* first; then *Graph*. Choose a decision and see what it
   produced and what was built after it; select nodes and read their detail
   beneath.
4. Restyle: change `--primary` or `--radius` in `apps/studio/src/theme.css`, run
   `npm run studio`, and watch everything follow.
