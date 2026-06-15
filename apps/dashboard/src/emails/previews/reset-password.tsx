/**
 * Preview entry for `react-email`'s dev server (`pnpm email:dev`). See
 * `verify-email.tsx` in this dir — dev-only, relative import, sample props.
 */
import { ResetPassword } from "../reset-password";

export default function ResetPasswordPreview() {
  return (
    <ResetPassword
      email="devon@acme.dev"
      url="https://app.example.com/reset-password?token=preview-token"
    />
  );
}
