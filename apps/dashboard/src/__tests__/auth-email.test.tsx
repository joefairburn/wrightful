import { describe, expect, it, vi } from "vite-plus/test";
import { renderEmail } from "@/lib/render-email";
import { ResetPassword } from "@/emails/reset-password";
import { VerifyEmail } from "@/emails/verify-email";

// Render the real templates; mock only the transport so we assert the
// verification/reset wiring (right subject + the link embedded in the body)
// without touching the `cloudflare:workers` binding.
const sendEmail = vi.fn(() =>
  Promise.resolve({ sent: true, messageId: "m_1" }),
);
vi.mock("@/lib/email", () => ({ sendEmail }));

describe("auth email templates", () => {
  it("VerifyEmail embeds the verification URL, recipient, and a CTA", async () => {
    const url = "https://app.example.com/api/auth/verify-email?token=abc";
    const { html, text } = await renderEmail(
      <VerifyEmail url={url} email="alice@example.com" />,
    );

    expect(html).toContain(url);
    expect(html).toContain("Verify email");
    expect(html).toContain("alice@example.com");
    expect(text).toContain(url);
  });

  it("ResetPassword embeds the reset URL and a CTA", async () => {
    const url = "https://app.example.com/reset-password?token=xyz";
    const { html } = await renderEmail(
      <ResetPassword url={url} email="bob@example.com" />,
    );

    expect(html).toContain(url);
    expect(html).toContain("Reset password");
    expect(html).toContain("bob@example.com");
  });
});

describe("auth-email senders", () => {
  it("sendVerificationEmail renders VerifyEmail and sends with the right subject", async () => {
    const { sendVerificationEmail } = await import("@/lib/auth-email");
    await sendVerificationEmail({
      email: "alice@example.com",
      name: "Alice",
      url: "https://app.example.com/verify?token=abc",
    });

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "alice@example.com",
        subject: "Verify your email for Wrightful",
        html: expect.stringContaining(
          "https://app.example.com/verify?token=abc",
        ),
      }),
    );
  });

  it("sendPasswordResetEmail renders ResetPassword and sends with the right subject", async () => {
    const { sendPasswordResetEmail } = await import("@/lib/auth-email");
    await sendPasswordResetEmail({
      email: "bob@example.com",
      url: "https://app.example.com/reset-password?token=xyz",
    });

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "bob@example.com",
        subject: "Reset your Wrightful password",
      }),
    );
  });
});
