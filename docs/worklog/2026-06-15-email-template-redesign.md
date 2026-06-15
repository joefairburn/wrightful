# 2026-06-15 — Email template redesign (dark theme, richer alert layout)

## What changed

Recreated all four transactional email templates from a designer-supplied HTML
mockup (`emails.html`), overwriting the previous light-monochrome versions. The
new look is a **dark theme** matching the app's `.dark` palette, with a richer
layout: status pills, a bordered key/value metadata table, code/trace blocks, a
verification token box, a boxed link fallback, an in-card footer, and a centered
legal line below the card.

The four templates are unchanged in identity — `verify-email`, `reset-password`,
and `monitor-alert` (which still renders both the `down` and `recovery` kinds via
`kind`). The chrome and building blocks were factored into shared modules so the
templates stay declarative.

### New / restructured files

| File                                                         | Role                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/emails/layout.tsx`                                      | Rewritten. Dark `EmailLayout` (now takes `headerRight` / `footer` / `legal` slots) + exported `palette` (email-safe hex) + `fonts`.                                                                                  |
| `src/emails/components.tsx`                                  | **New.** Email-safe building blocks: `Heading1`, `Lead`, `Pill`, `MetaBox`/`MetaRowData`, `CodeBox`, `ButtonRow`, `TokenBox`, `LinkFallback`, `Note`, `FooterText`, `LegalText`, plus `strong`/`mono` inline styles. |
| `src/emails/{verify-email,reset-password,monitor-alert}.tsx` | Rewritten to compose the blocks above and match the mockup copy.                                                                                                                                                     |
| `src/emails/previews/*`                                      | Updated with rich sample props so `pnpm email:dev` exercises the full design.                                                                                                                                        |

### Palette derivation

The mockup referenced an (unattached) `tokens.css` and used the app's CSS custom
properties in **dark** mode. Those tokens are `oklch` in `src/styles.css`, which
email clients don't support, so I converted them to sRGB hex and pre-blended the
14%-alpha "soft" status fills over the card surface (`bg1`). The conversion +
blend math lives only in the worklog history; the resulting constants are in
`layout.tsx#palette`. Layout uses React Email's table-based `<Row>`/`<Column>`
(no flexbox/grid) so the columns survive Outlook.

### Graceful-degradation contract for monitor alerts

The mockup shows incident metadata Wrightful doesn't yet track (region,
failing-since, consecutive-failure / downtime / failed-check counts). Rather than
fabricate it or build an incident model, `MonitorAlertProps` exposes those as
**optional** props and `MetaBox` drops any row whose value is absent. Production
passes the subset it actually has; previews pass the full set so the design is
fully visible during template work.

- **Wired to real data** (in `src/lib/monitors/alerts.tsx`): `teamName` (header),
  `intervalSeconds` → "every 5 minutes", `errorMessage` → the trace block,
  `lastDurationMs` (recovery), `url` → "View monitor" + the footer "Manage this
  monitor" link. `resolveMonitorUrl` was widened to `resolveMonitorMeta` (one
  query now returns both the deep link and the team name; the name resolves even
  when `WRIGHTFUL_PUBLIC_URL` is unset).
- **Design-only / omitted in production** (rendered only when a value is passed):
  region, failing-since, consecutive-failures, recovered-at, downtime,
  failed-checks. Also dropped from the mockup as not-yet-real: the "View
  incident" / "Pause this monitor" / "See incident timeline" secondary CTAs (no
  such routes), the OTP code box in verification (link-based flow — kept as an
  optional `code` prop, off by default), and the placeholder postal address +
  "Status/Docs/Help center" legal links.

### Auth config aligned to the copy

The mockup copy asserts specific token windows, so I set them in `auth.ts` to
keep the emails truthful (Better Auth defaults both to 1 hour):

- `emailAndPassword.resetPasswordTokenExpiresIn = 60 * 30` (matches "expires in 30 minutes").
- `emailVerification.expiresIn = 60 * 60 * 24` (matches "expires in 24 hours").

The templates centralize the same labels via an `expiresLabel` prop default.

### Prop contract change

`VerifyEmail` / `ResetPassword` now take `email` (the recipient address, shown in
the copy + footer) instead of `name`; `auth-email.tsx` passes `email`. Both keep
backward-compatible optional shapes.

## Verification

- `vp check` — **0 errors**, 43 pre-existing warnings (419 files); formatting clean.
- `vp test run` — **904 passed** (86 files). Updated assertions: `auth-email.test.tsx`
  (new `email` prop), `alerts.test.tsx` ("is down" → "Monitor down" to match the
  pill copy).
- Ad-hoc render check (since removed) confirmed the full down alert emits the dark
  card/page backgrounds, status pill, team header, formatted interval, all
  metadata rows, the trace block, the CTA, and the footer link.
- `pnpm email:dev` previews render the complete design with sample data.

## Update — incident metrics + run CTA wired from execution history

Followed up on the "design-only metadata" gap by deriving the meaningful subset
from `monitorExecutions` history at send time — no schema change.

- **New pure helpers in `alerts.tsx`** (`findLastPassAt`, `summarizeRecovery`,
  with `ranAt`/`settledAt` accessors over an `ExecutionTimelineRow`), plus
  `formatUtc` (epoch-seconds → "Jun 15, 14:32 UTC", manual to avoid ICU variance)
  and `formatDowntime` (seconds → "35m 12s"). `loadRecentExecutions` pulls a
  bounded window (`ALERT_HISTORY_LIMIT = 200`, on the `(projectId, monitorId,
createdAt)` index) after the recipient check.
- **Recovery alert** now shows `recoveredAt`, `downtime`, and `failedChecks`
  summarizing the just-ended outage (the run of fail/error executions immediately
  before the recovering one). All three were already optional template props.
- **Down alert**: the alert is **edge-triggered** (fires only at the first
  failure), so a "consecutive failures" count would always be 1 and "failing
  since" would always be ≈now — both noise. Replaced those two props with
  `lastPassedAt` (the most recent prior `pass`), which is the meaningful down-side
  signal. Rendered as a "Last passed" metadata row + a lead clause.
- **Secondary CTA**: `result.runId` deep-links to the triggering run report
  (`/t/{team}/p/{project}/runs/{runId}`), so the alert gets a "View run" ghost
  button alongside "View monitor" — a genuinely distinct destination (not a
  redundant link to the same page). `resolveMonitorUrl` → `resolveMonitorMeta`
  now returns `{ url, runUrl, teamName }` from one query.
- Helpers are unit-tested (`alerts.test.tsx`, +7 cases): streak counting,
  non-terminal (queued/running) row skipping, the empty-streak / no-prior-pass
  edges. `vp test run` → **911 passed**; `vp check` 0 errors.

_Saturation note:_ an outage longer than `ALERT_HISTORY_LIMIT` checks (~16h at a
5-min cadence) caps the count/duration at the window edge.

### Removed the remaining design-only aspects

The two template fields with no production data source were deleted outright
(rather than left as never-populated optional props), keeping the surface honest:

- **`region`** (monitor alert) — v1 is single-origin, no per-execution location.
  Dropped the prop, the "Region" metadata row, and its slot in the recovery
  "Last run" value (now just the duration).
- **The verification OTP code box** (`code` prop + the `TokenBox` component and
  its styles) — Wrightful's flow is link-based; there is no code to show. The
  verify "Note" copy simplified to "This link expires in {expiresLabel}."

### Declared the dark color-scheme (no light variant)

These emails are intentionally always-dark. A _light_ variant isn't viable: per-
element light/dark needs `@media (prefers-color-scheme)` in a `<style>` block,
which Gmail strips (and inline styles, which Gmail requires, can't carry media
queries) — so adaptation would only work in Apple Mail / a few clients and never
Gmail. Instead the layout now DECLARES the dark scheme so supporting clients stop
auto-inverting it: `<meta name="color-scheme">` + `<meta
name="supported-color-schemes">` (both `dark`) and a `:root { color-scheme:
dark }` style in `<Head>`, plus `colorScheme: "dark"` on the body. Light-mode
recipients still receive the dark design (a deliberate brand choice, matching how
most transactional senders ship a single fixed theme).

- CAN-SPAM: transactional auth mail is generally exempt from the physical-address
  requirement, but if a real postal address / unsubscribe-routing is wanted in the
  footer it should come from config, not hardcoded mockup placeholders.
- `region` / per-location alerts would return if multi-origin scheduling lands.
- A literal one-click "Pause this monitor" from the email needs a signed,
  expiring action route (`GET /monitors/:id/pause?token=…`); deferred. "View
  monitor" + the footer "Manage this monitor" link cover it via the page for now.
- A real "incident" entity / timeline (vs. the on-the-fly history summary) remains
  a separate feature.
- "Consecutive failures" / "failing since" become meaningful only if still-down
  reminder alerts are ever added (the props were removed until then).
- Dark-background email rendering varies by client (some force-invert); revisit if
  a light variant is ever needed.
