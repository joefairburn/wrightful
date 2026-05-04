import { type Locator, type Page, expect } from "@playwright/test";

/**
 * Page object for /login and /signup. Both routes render the same
 * `<LoginForm>` with a `name` input added in signup mode, so this
 * single class covers both flows.
 */
export class LoginPage {
  readonly page: Page;
  readonly nameInput: Locator;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly signInButton: Locator;
  readonly createAccountButton: Locator;
  readonly errorAlert: Locator;
  readonly signUpHeading: Locator;

  constructor(page: Page) {
    this.page = page;
    this.nameInput = page.getByLabel(/^name$/i);
    this.emailInput = page.getByLabel(/email/i);
    this.passwordInput = page.getByLabel(/password/i);
    this.signInButton = page.getByRole("button", { name: /sign in/i });
    this.createAccountButton = page.getByRole("button", {
      name: /create account/i,
    });
    this.errorAlert = page.getByRole("alert");
    this.signUpHeading = page.getByRole("heading", {
      name: /create your account/i,
    });
  }

  async gotoSignIn(): Promise<void> {
    await this.page.goto("/login");
  }

  async gotoSignUp(): Promise<void> {
    await this.page.goto("/signup");
    await expect(this.signUpHeading).toBeVisible();
  }

  async signIn(email: string, password: string): Promise<void> {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.signInButton.click();
  }

  async signUp(opts: {
    name: string;
    email: string;
    password: string;
  }): Promise<void> {
    await this.nameInput.fill(opts.name);
    await this.emailInput.fill(opts.email);
    await this.passwordInput.fill(opts.password);
    await this.createAccountButton.click();
  }

  /** Wait for navigation away from /login or /signup. */
  async waitForLandedOff(prefix: "/login" | "/signup"): Promise<void> {
    await this.page.waitForURL((url) => !url.pathname.startsWith(prefix), {
      timeout: 15_000,
    });
  }
}
