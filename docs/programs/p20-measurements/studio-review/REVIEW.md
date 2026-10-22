# Studio Overview visual review (P20, S-04, J8, criterion 16)

Regenerate with `npm run build && node scripts/studio-preview-shots.mjs` (exit 0 required).
`widths.json` holds, per image, the viewport width, `document.documentElement.scrollWidth`, text clipped
without a full-text title (must be empty) and the count of truncations that do carry a title.
Final state: 56 images, every `scrollWidth` equals the viewport width (mobile 390), no clipped text.

## Images

Each name is `<scenario>-<shot>-<viewport>-<theme>.png`, viewport = desktop (1440) | mobile (390), theme = light | dark.
Four images exist per name below (desktop/mobile x light/dark).

| Image set | Scenario / shot | Looked at |
|---|---|---|
| `complete-overview-*` | finished run, run scope | desktop-light, mobile-dark, mobile-light (width check) and desktop-dark by script only |
| `complete-history-*` | complete, history scope | desktop-light, mobile-dark |
| `complete-evidence-consumed-*` | Consumed tile evidence sheet open | desktop-light, mobile-dark |
| `sparse-overview-*` | routes with usage, no summaries/events/verdict | desktop-light, mobile-dark |
| `running-overview-*` | open work, waiting node, stale | desktop-light, mobile-dark |
| `failed-overview-*` | failed run, no success | desktop-light |
| `error-overview-*` | reads refused (503) | desktop-light, mobile-dark |
| `loading-overview-*` | reads never answer | desktop-light, mobile-dark |
| `partial-history-overview-*`, `partial-history-history-*` | sparse run + a member with no records | history: desktop-light; overview: mobile-dark |
| `running-history-overview-*`, `running-history-history-*` | running anchor + failed earlier member | history: mobile-dark |
| `failed-history-overview-*`, `failed-history-history-*` | failed anchor + failed earlier member | history: mobile-dark |

Not viewed by eye (covered only by the scripted width/clipping checks, which pass): failed-overview mobile-dark/desktop-dark/mobile-light,
failed-history-overview, running-history-overview and the dark/desktop variants of the history shots other than those listed.
Of the 56 images 22 were opened; mobile images are tall and were viewed downscaled, so fine detail there was judged mainly from desktop and from the script's measurements.

## What was inspected

Hierarchy, density, contrast (muted captions in dark mode stayed legible: no change needed), clipping and truncated labels,
misleading chart states, missing-value rendering ("not observed", never 0), token vs dollar separation, verdict prominence,
and stale/running/failed/error/loading states.

## Fixed

1. **Mobile page overflowed sideways (571-617px wide).** Causes, all layout: `SidebarInset` (flex child) lacked `min-w-0`; the run page's
   and Overview's single-column grids (`grid gap-4`) sized to their widest child (tab strip, scope select); the header card's grid likewise; the scope
   select's row did not wrap. Fixed in `ui/sidebar.tsx`, `pages/run.tsx`, `overview-tab.tsx`, `header.tsx` (`min-w-0`, `grid-cols-[minmax(0,1fr)]`, `flex-wrap`).
   The eight-tab strip now scrolls inside its own `overflow-x-auto` wrapper instead of widening the page.
2. **Timeline row names cut by `slice(0, 26)` with no ellipsis or full text** ("Persist invoices to the st"). Now ends with "…" and the full name is the row's SVG `<title>`.
3. **Bar labels (`truncate`) had no full text.** `title={bar.label}` added in `bars.tsx` (the button's aria-label already had it).
4. **Breadcrumb objective shortened to 48 characters without the full text.** The crumb now carries `title`; the mobile header was fixed-height `h-14` so a wrapped
   breadcrumb spilled over the border: now `min-h-14 py-2`.
5. **Account name in the sidebar/menu truncated** (`reviewer@example.t…`): `title` added.
6. **"as of" marker overprinted the last axis tick** on the running timeline: the tick label within 60px of the marker is omitted while the run is live.

## Accepted, with reason

- Member runs table (`min-w-[32rem]`) on mobile scrolls horizontally inside its own `overflow-x-auto` container; Status/Verdict columns need a sideways swipe.
  The page itself does not overflow; a stacked card layout would be a redesign.
- Timeline chart keeps `min-w-[720px]` and scrolls inside its container on mobile; the legend and "Show as text" give the same facts without scrolling.
- Tab strip on mobile ("Timel…" cut at the edge) scrolls; no scroll affordance added.
- Evidence sheet is a fixed-height overlay; its long text scrolls inside the sheet, so only the top of it appears in the full-page capture.
- The sheet's infrastructure basis prints an unrounded rate (`0.010958904109589041 USD/h`). That string is core report text (`packages/core/src/report/infrastructure.ts`); left alone because it is the evidence record, not Studio layout.
- Completion checkpoint in `complete` shows "Combined estimate: not observed" while the live tile shows $13.17: the fixture's frozen checkpoint holds no combined figure. It is rendered honestly as missing, not zero; fixtures were not changed.
- Loading shows the program crumb as the id (`00000001`) until the contract read returns, and error/loading skeletons are blank by design.
- Running "Delivered 1 of 1" is a settled-jobs denominator; the unfinished jobs are named on the line below it ("not in the denominator").
- Colours are all theme tokens (theme-guard passes); verdict buttons are the most prominent control in the header card in every theme.

## 2026-10-22: history scope shows delivery, rework, review and bottleneck evidence (S-04 fix round 2, job C)

The completion-history scope now carries Delivered and Repair and review tiles, evidence sheets for them, a rework-by-cause bar and a per-member
time table, all from `CompletionReport.current` (`delivery`, `rework`, `review`, `operations`, `evidenceCoverage`).

Looked at by eye (regenerated by `node scripts/studio-preview-shots.mjs`, exit 0, every shot's scrollWidth equal to its viewport width):
`complete-history-desktop-light`, `complete-history-mobile-dark`, `partial-history-history-mobile-dark`, `running-history-history-desktop-light`
(the first two and the running one again after the fixes below). The other history shots were generated and passed the overflow check but were not opened.

Fixed:
1. A running anchor's member row showed Elapsed "not observed"; it now reads "still running" (the text equivalent says "so far, the run is still running").
2. The per-member time table clipped its columns on mobile ("Qu", "no ob") inside its scroll container with nothing to say so: the container is now a keyboard-focusable
   labelled section and a mobile-only line says to scroll sideways. The page itself does not overflow.
3. Wait/queue/integration/examination unions of a member with no lifecycle observations (all zero, no summed work) read "not observed", not "0s", in the table, the text
   equivalent and the sheet. The complete scenario's correction run shows this honestly.

Accepted: the partial-history shot shows the unrecorded member as "not readable" in the timeline and "not observed" in the time table, with its key named under the table;
the rework panel there reads "not observed: nothing to draw" because the one readable member has no rework. The panel heading repeats "Rework by cause" (card title and chart title); left as the run page's chart does the same.
The committed SC-12 fixture holds no lifecycle events, so the Studio cannot rebuild that test's integration 45s / work 405s; it says "not observed" for them (sc12.test.tsx asserts this).
