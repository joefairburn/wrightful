/**
 * Preview entry for `react-email`'s dev server (`pnpm email:dev`). NOT shipped
 * to the worker — nothing imports it; it only feeds the local browser preview.
 * Uses a relative import (the `@` alias isn't known to the email CLI's bundler)
 * and renders the real template with sample props.
 */
import { VerifyEmail } from "../verify-email";

export default function VerifyEmailPreview() {
  return (
    <VerifyEmail
      email="devon@acme.dev"
      url="https://app.example.com/api/auth/verify-email?token=preview-token"
    />
  );
}
