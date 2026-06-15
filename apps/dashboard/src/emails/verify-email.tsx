/**
 * Email-verification message. Sent from Better Auth's
 * `emailVerification.sendVerificationEmail` hook (`auth.ts`); `url` is the
 * Better-Auth-built verification link (clicking it verifies + redirects to the
 * configured callback). `expiresLabel` must match `emailVerification.expiresIn`
 * in `auth.ts`.
 */
import {
  ButtonRow,
  FooterText,
  Heading1,
  Lead,
  LegalText,
  mono,
  Note,
} from "./components";
import { EmailLayout } from "./layout";

export interface VerifyEmailProps {
  url: string;
  email?: string | null;
  /** Human expiry window — keep in sync with `emailVerification.expiresIn`. */
  expiresLabel?: string;
}

export function VerifyEmail({
  url,
  email,
  expiresLabel = "24 hours",
}: VerifyEmailProps) {
  return (
    <EmailLayout
      preview="Confirm your email to activate your Wrightful account."
      footer={
        <FooterText>
          {email ? (
            <>
              This message was sent to <span style={mono}>{email}</span> during
              sign-up for Wrightful.
            </>
          ) : (
            "This message was sent to you during sign-up for Wrightful."
          )}
        </FooterText>
      }
      legal={
        <LegalText>
          Wrightful — synthetic monitoring &amp; Playwright reporting
        </LegalText>
      }
    >
      <Heading1>Verify your email</Heading1>
      <Lead>
        Confirm{" "}
        {email ? <span style={mono}>{email}</span> : "your email address"} to
        finish setting up your account and start streaming Playwright runs into
        Wrightful.
      </Lead>
      <ButtonRow primary={{ href: url, label: "Verify email" }} />
      <Note>
        This link expires in {expiresLabel}. If you didn’t create a Wrightful
        account, no action is needed — you can ignore this email.
      </Note>
    </EmailLayout>
  );
}
