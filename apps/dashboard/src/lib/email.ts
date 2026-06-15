/**
 * Outbound email transport over the Cloudflare Email Service (CES) `EMAIL`
 * binding (declared in `wrangler.jsonc#send_email`, read here via the
 * `cloudflare:workers` `env`).
 *
 * This is the provider seam: every email the app sends — verification,
 * password reset, monitor alerts — goes through `sendEmail`, so swapping CES
 * for another transport (e.g. Resend over `fetch`) is a change confined to
 * this file. Templates are rendered to HTML/text elsewhere
 * (`src/lib/render-email.tsx`) and handed in as strings, keeping this module
 * unaware of React.
 *
 * Email is an OPTIONAL capability. When it isn't set up (no `EMAIL` binding or
 * no `EMAIL_FROM`), `sendEmail` skips gracefully and returns
 * `{ sent: false, reason: "not_configured" }` — it never throws for the
 * unconfigured case, so a self-hoster who hasn't enabled CES is never blocked
 * and callers don't have to guard. (`void deploy` never hard-fails either:
 * `EMAIL_FROM` is `optional()`.) A *transport* failure when it IS configured
 * still throws — that's a real misconfiguration to surface, not a missing
 * feature.
 *
 * The binding is resolved via `cloudflare:workers` rather than threaded
 * through a Hono `c.env`, because the call sites that need it — Better Auth
 * `sendVerificationEmail`/`sendResetPassword` hooks and the monitor queue
 * consumer — don't receive a request context.
 *
 * Local dev / tests never deliver real mail: Miniflare's built-in `send_email`
 * simulator logs the message (and writes the bodies to a temp dir) instead.
 */
import { env as bindings } from "cloudflare:workers";
import { env } from "void/env";
import { logger } from "void/log";

/**
 * The structured Cloudflare Email Service send API (the "MessageBuilder"
 * form), as called at runtime. The published `@cloudflare/workers-types`
 * `SendEmail` only types the legacy `send(EmailMessage)` (raw-MIME) overload,
 * so we declare the structured shape we actually use and launder the loosely
 * typed `cloudflare:workers` `env` to it at the single boundary in
 * `resolveEmailBinding` — the same pattern `rate-limit.ts` uses for the
 * untyped rate-limiter bindings.
 */
export interface EmailBinding {
  send(message: {
    from: string;
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
  }): Promise<{ messageId: string }>;
}

export interface SendEmailParams {
  /** One or more recipient addresses. */
  to: string | string[];
  subject: string;
  /** HTML body. Produce it (with a matching `text`) via `renderEmail`. */
  html: string;
  /** Plain-text fallback. Strongly recommended for deliverability. */
  text?: string;
  /**
   * Override the `EMAIL_FROM` env default. The address must belong to a
   * domain onboarded to CES or the send is rejected.
   */
  from?: string;
}

/**
 * Outcome of `sendEmail`. `not_configured` is the graceful skip when email
 * isn't set up — a normal, expected state for a deployment that doesn't use
 * email, NOT an error. (A transport failure when email IS configured throws
 * instead, so it isn't represented here.)
 */
export type SendEmailResult =
  | { sent: true; messageId: string }
  | { sent: false; reason: "not_configured" };

/**
 * The CES send binding, or `undefined` when it isn't present (it is absent in
 * a deploy that didn't merge `wrangler.jsonc#send_email`, and Miniflare only
 * wires it when the block is declared).
 */
export function resolveEmailBinding(): EmailBinding | undefined {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- `bindings` is the loosely-typed cloudflare:workers env; launder to the structured CES shape at this single boundary (the published SendEmail type omits the MessageBuilder overload we call)
  return (bindings as { EMAIL?: EmailBinding }).EMAIL;
}

/**
 * Whether outbound email can be sent: both the `EMAIL` binding and an
 * `EMAIL_FROM` address are present. Use this to gate optional behavior (e.g.
 * sending a monitor alert) without triggering `EmailNotConfiguredError`.
 */
export function isEmailConfigured(): boolean {
  return Boolean(resolveEmailBinding()) && Boolean(env.EMAIL_FROM);
}

/**
 * Pure send core: deliver a single message through an explicit binding + from
 * address. Logs and rethrows on transport failure (so a critical-path caller
 * sees the error and Cloudflare Tail records it). Separated from `sendEmail`
 * so it's unit-testable with a mock binding, without resolving the
 * `cloudflare:workers` env.
 */
export async function deliverEmail(
  binding: EmailBinding,
  from: string,
  params: SendEmailParams,
): Promise<{ messageId: string }> {
  try {
    return await binding.send({
      from,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    });
  } catch (err) {
    logger.error("email send failed", {
      to: Array.isArray(params.to) ? params.to.join(", ") : params.to,
      subject: params.subject,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Send an email via the CES `EMAIL` binding. Resolves the binding from
 * `cloudflare:workers` and the from address from `EMAIL_FROM` (overridable per
 * call), then delegates to `deliverEmail`.
 *
 * Graceful by default: when email isn't configured (no binding or no from
 * address) it returns `{ sent: false, reason: "not_configured" }` rather than
 * throwing, so an optional email feature degrades cleanly on a deployment that
 * hasn't set CES up. It still throws on a *transport* failure when it is
 * configured — callers that want fully best-effort behavior should `try/catch`
 * (or check `isEmailConfigured()` up front).
 */
export async function sendEmail(
  params: SendEmailParams,
): Promise<SendEmailResult> {
  const binding = resolveEmailBinding();
  const from = params.from ?? env.EMAIL_FROM;
  if (!binding || !from) {
    return { sent: false, reason: "not_configured" };
  }
  const { messageId } = await deliverEmail(binding, from, params);
  return { sent: true, messageId };
}
