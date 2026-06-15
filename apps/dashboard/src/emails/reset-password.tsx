/**
 * Password-reset message. Sent from Better Auth's
 * `emailAndPassword.sendResetPassword` hook (`auth.ts`); `url` is the
 * Better-Auth-built reset link that lands on the `/reset-password` page with a
 * one-time token. `expiresLabel` must match `resetPasswordTokenExpiresIn` in
 * `auth.ts`.
 */
import {
  ButtonRow,
  FooterText,
  Heading1,
  Lead,
  LegalText,
  LinkFallback,
  mono,
  Note,
  strong,
} from "./components";
import { EmailLayout } from "./layout";

export interface ResetPasswordProps {
  url: string;
  email?: string | null;
  /** Human expiry window — keep in sync with `resetPasswordTokenExpiresIn`. */
  expiresLabel?: string;
}

export function ResetPassword({
  url,
  email,
  expiresLabel = "30 minutes",
}: ResetPasswordProps) {
  return (
    <EmailLayout
      preview={`Reset your Wrightful password — this link expires in ${expiresLabel}.`}
      footer={
        <FooterText>
          {email ? (
            <>
              This message was sent to <span style={mono}>{email}</span> because
              a password reset was requested for your Wrightful account.
            </>
          ) : (
            "This message was sent because a password reset was requested for your Wrightful account."
          )}
        </FooterText>
      }
      legal={
        <LegalText>
          Wrightful — synthetic monitoring &amp; Playwright reporting
        </LegalText>
      }
    >
      <Heading1>Reset your password</Heading1>
      <Lead>
        We got a request to reset the password for{" "}
        {email ? <span style={mono}>{email}</span> : "your Wrightful account"}.
        Choose a new one with the button below — it works once and expires in{" "}
        <span style={strong}>{expiresLabel}</span>.
      </Lead>
      <ButtonRow primary={{ href: url, label: "Reset password" }} />
      <LinkFallback url={url} />
      <Note>
        Didn’t request this? You can safely ignore this email — your password
        won’t change.
      </Note>
    </EmailLayout>
  );
}
