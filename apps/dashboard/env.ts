import { boolean, defineEnv, number, string, url } from "void/env";

export default defineEnv({
  /**
   * Public origin for the dashboard. Used by void auth for OAuth callback
   * URLs and for building artifact download links sent back to the reporter.
   * Local dev: http://localhost:5173. Production: set via `void secret put`.
   */
  WRIGHTFUL_PUBLIC_URL: url(),

  /**
   * Auth signing secret. ≥32 chars (generate with `openssl rand -base64 32`).
   * Drives Better Auth's session cookie HMAC and our short-lived artifact
   * download tokens. On Void Cloud this is auto-created if unset.
   */
  BETTER_AUTH_SECRET: string().secret(),

  /**
   * Optional dedicated secret for signing short-lived artifact download tokens.
   * Decouples those (low-value, broadly-minted, HTML-embeddable) capabilities
   * from the session-signing BETTER_AUTH_SECRET: with it set, a leaked artifact
   * token is revoked by rotating THIS secret without logging out every user.
   * Falls back to BETTER_AUTH_SECRET when unset (backward compatible). ≥32 chars.
   */
  ARTIFACT_TOKEN_SECRET: string().secret().optional(),

  /**
   * GitHub OAuth credentials. Void's auth layer expects the `AUTH_GITHUB_*`
   * naming convention — `AUTH_<PROVIDER>_CLIENT_{ID,SECRET}` — and wires
   * them through automatically when "github" is in `void.json#auth.providers`.
   * Optional: leave both unset to hide the "Continue with GitHub" button.
   */
  AUTH_GITHUB_CLIENT_ID: string().optional(),
  AUTH_GITHUB_CLIENT_SECRET: string().secret().optional(),

  /**
   * Per-artifact upload size cap. Enforced in /api/artifacts/register and
   * again as Content-Length in /api/artifacts/:id/upload. Default 50 MiB.
   */
  WRIGHTFUL_MAX_ARTIFACT_BYTES: number().default(52428800),

  /**
   * Minutes a run can sit at status='running' before the cron watchdog marks
   * it 'interrupted'. Default 30 — longer than any realistic single test run,
   * shorter than someone-checks-the-dashboard-the-next-morning.
   */
  WRIGHTFUL_RUN_STALE_MINUTES: number().default(30),

  /**
   * Enable open email/password signup. Off by default — email verification
   * isn't wired yet, so self-hosters running multi-user need to leave this
   * `false` and create users via invites.
   */
  ALLOW_OPEN_SIGNUP: boolean().default(false),
});
