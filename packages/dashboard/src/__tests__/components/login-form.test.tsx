import { describe, it, expect, vi, beforeEach } from "vitest";

const { signInMock, signUpMock, navigateMock } = vi.hoisted(() => ({
  signInMock: vi.fn(),
  signUpMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: signInMock },
    signUp: { email: signUpMock },
  },
}));
vi.mock("rwsdk/client", () => ({
  navigate: navigateMock,
}));

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginForm } from "@/app/pages/login-form";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LoginForm — sign-in mode", () => {
  it("renders email + password fields and the Sign in button", () => {
    render(<LoginForm mode="signin" callbackURL="/dashboard" />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign in/i }),
    ).toBeInTheDocument();
    // No name field in sign-in mode.
    expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument();
  });

  it("submits credentials to authClient.signIn.email and navigates on success", async () => {
    const user = userEvent.setup();
    signInMock.mockResolvedValueOnce({ error: null });
    render(<LoginForm mode="signin" callbackURL="/after-login" />);

    await user.type(screen.getByLabelText(/email/i), "joe@example.com");
    await user.type(screen.getByLabelText(/password/i), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(signInMock).toHaveBeenCalledWith({
      email: "joe@example.com",
      password: "hunter2hunter2",
      callbackURL: "/after-login",
    });
    expect(navigateMock).toHaveBeenCalledWith("/after-login");
  });

  it("shows the error message when sign-in fails", async () => {
    const user = userEvent.setup();
    signInMock.mockResolvedValueOnce({
      error: { message: "Invalid email or password" },
    });
    render(<LoginForm mode="signin" callbackURL="/x" />);

    await user.type(screen.getByLabelText(/email/i), "joe@example.com");
    await user.type(screen.getByLabelText(/password/i), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(
      await screen.findByText("Invalid email or password"),
    ).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("disables the submit button while pending", async () => {
    const user = userEvent.setup();
    let resolveSignIn!: (v: { error: null }) => void;
    signInMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveSignIn = res;
      }),
    );
    render(<LoginForm mode="signin" callbackURL="/x" />);

    await user.type(screen.getByLabelText(/email/i), "joe@example.com");
    await user.type(screen.getByLabelText(/password/i), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(screen.getByRole("button", { name: /signing in/i })).toBeDisabled();

    resolveSignIn({ error: null });
  });

  it("sanitises a hostile callbackURL via safeNextPath before navigating", async () => {
    const user = userEvent.setup();
    signInMock.mockResolvedValueOnce({ error: null });
    render(<LoginForm mode="signin" callbackURL="https://evil.example/" />);

    await user.type(screen.getByLabelText(/email/i), "joe@example.com");
    await user.type(screen.getByLabelText(/password/i), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    // safeNextPath should reject absolute URLs and fall back to a safe default.
    expect(navigateMock).toHaveBeenCalled();
    const arg = navigateMock.mock.calls[0][0] as string;
    expect(arg).not.toMatch(/^https?:/);
  });
});

describe("LoginForm — sign-up mode", () => {
  it("renders the name field and the Create account button", () => {
    render(<LoginForm mode="signup" callbackURL="/x" />);
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /create account/i }),
    ).toBeInTheDocument();
  });

  it("blocks submit when password is shorter than 12 chars (no auth call)", async () => {
    const user = userEvent.setup();
    render(<LoginForm mode="signup" callbackURL="/x" />);

    await user.type(screen.getByLabelText(/^name$/i), "Joe");
    await user.type(screen.getByLabelText(/email/i), "joe@example.com");
    await user.type(screen.getByLabelText(/password/i), "short1");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    // The error appears in the alert; assert via role to avoid colliding with
    // the help text below the password field.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /at least 12 characters and include a number/i,
    );
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it("blocks submit when password has no number (no auth call)", async () => {
    const user = userEvent.setup();
    render(<LoginForm mode="signup" callbackURL="/x" />);

    await user.type(screen.getByLabelText(/^name$/i), "Joe");
    await user.type(screen.getByLabelText(/email/i), "joe@example.com");
    await user.type(screen.getByLabelText(/password/i), "abcdefghijklmn");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /include a number/i,
    );
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it("calls authClient.signUp.email when the policy is satisfied", async () => {
    const user = userEvent.setup();
    signUpMock.mockResolvedValueOnce({ error: null });
    render(<LoginForm mode="signup" callbackURL="/dash" />);

    await user.type(screen.getByLabelText(/^name$/i), "Joe");
    await user.type(screen.getByLabelText(/email/i), "joe@example.com");
    await user.type(screen.getByLabelText(/password/i), "abcdefghijkl1");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(signUpMock).toHaveBeenCalledWith({
      email: "joe@example.com",
      password: "abcdefghijkl1",
      name: "Joe",
      callbackURL: "/dash",
    });
  });
});
