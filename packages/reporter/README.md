# @wrightful/reporter

Playwright reporter that streams test results to your Wrightful dashboard as
each test completes, so results appear live instead of only at the end of the
CI run.

## Install

```bash
pnpm add -D @wrightful/reporter
```

## Usage

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  reporter: [
    ["list"],
    [
      "@wrightful/reporter",
      {
        url: process.env.WRIGHTFUL_URL,
        token: process.env.WRIGHTFUL_TOKEN,
        environment: "ci",
      },
    ],
  ],
});
```

Options:

| option            | default               | notes                                                             |
| ----------------- | --------------------- | ----------------------------------------------------------------- |
| `url`             | `WRIGHTFUL_URL` env   | Dashboard base URL                                                |
| `token`           | `WRIGHTFUL_TOKEN` env | Bearer API key                                                    |
| `batchSize`       | `20`                  | Max results per flush                                             |
| `flushIntervalMs` | `500`                 | Max ms to wait between flushes                                    |
| `environment`     | —                     | Environment tag for the run                                       |
| `artifacts`       | `'failed'`            | Which tests' attachments to upload: `'all' \| 'failed' \| 'none'` |

## Fail-closed semantics

The reporter never fails the Playwright suite. On error:

- Network / 5xx / 429 errors on open/append/complete/register calls are
  retried with exponential backoff (up to 3 attempts; 6 for the final
  `/complete` call). Each attempt is capped by a 30s timeout (120s for
  artifact PUTs).
- Auth errors (401/403) are **not** retried — the warning includes a hint
  to check `WRIGHTFUL_TOKEN`.
- Per-file artifact PUT failures are bounded: other uploads continue.
- An end-of-suite summary line reports how many tests streamed and how
  many artifacts uploaded.

**If `completeRun` fails after all retries, or the CI process is killed
before `onEnd` fires** (SIGKILL from the GitHub Actions cancel button,
OOM, infra teardown), the run will stay at `status='running'` briefly.
The dashboard's cron watchdog sweeps stuck runs every 5 minutes and marks
them `'interrupted'` once they're older than the configured threshold
(default 30 min, overridable via `WRIGHTFUL_RUN_STALE_MINUTES`).

SIGTERM (graceful cancellation) triggers a best-effort `/complete` with
`status='interrupted'` before exit, so typical CI cancellations get a
clean finalize without waiting for the watchdog.

## Artifacts

Attachments (traces, screenshots, videos) are uploaded incrementally as each
test completes — no separate `wrightful upload` pass required. Upload scope
follows the `artifacts` option:

- `'failed'` (default): upload for unexpected failures + flaky retries.
- `'all'`: upload for every test.
- `'none'`: skip artifact uploads entirely.

Semantics match the CLI's `--artifacts` flag. Per-file failures are logged
to stderr and do not block the run or other artifact uploads.

## Retried tests

Retried tests are aggregated into one row at their final outcome — a
fails-then-passes test streams as a single `flaky` row (not two separate
attempts), matching the bulk CLI upload. Non-retried tests stream as soon as
their single attempt completes.
