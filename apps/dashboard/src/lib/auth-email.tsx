/**
 * Renders + sends the Better Auth transactional emails (verification, password
 * reset). The `auth.ts` hooks dynamic-`import()` this at request time — `auth.ts`
 * is also evaluated at `void prepare` config time (bare Node, no `void/*` or
 * `cloudflare:workers` resolution), so it can't statically import the email
 * transport or React-Email renderer; the same deferral the GitHub-account
 * mirror uses.
 *
 * Both helpers `await sendEmail`, so a transport failure propagates into the
 * Better Auth hook and surfaces to the user (e.g. signup fails loudly rather
 * than leaving them unable to verify). When email isn't configured `sendEmail`
 * returns `{ sent: false }` and these are graceful no-ops — but in practice the
 * verification path is gated on `EMAIL_FROM` being set in `auth.ts`.
 */
import { ResetPassword } from "@/emails/reset-password";
import { VerifyEmail } from "@/emails/verify-email";
import { sendEmail } from "@/lib/email";
import { renderEmail } from "@/lib/render-email";

interface AuthEmailArgs {
  email: string;
  name?: string | null;
  url: string;
}

export async function sendVerificationEmail({
  email,
  url,
}: AuthEmailArgs): Promise<void> {
  const { html, text } = await renderEmail(
    <VerifyEmail url={url} email={email} />,
  );
  await sendEmail({
    to: email,
    subject: "Verify your email for Wrightful",
    html,
    text,
  });
}

export async function sendPasswordResetEmail({
  email,
  url,
}: AuthEmailArgs): Promise<void> {
  const { html, text } = await renderEmail(
    <ResetPassword url={url} email={email} />,
  );
  await sendEmail({
    to: email,
    subject: "Reset your Wrightful password",
    html,
    text,
  });
}
