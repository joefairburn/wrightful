import { requestInfo } from "rwsdk/worker";
import { hasGithubOAuthConfigured } from "@/lib/better-auth";

export function LoginPage() {
  const url = new URL(requestInfo.request.url);
  const next = url.searchParams.get("next") ?? "/";
  const callbackURL = encodeURIComponent(next);
  const githubHref = `/api/auth/sign-in/social?provider=github&callbackURL=${callbackURL}`;
  const mode = url.searchParams.get("mode") === "signup" ? "signup" : "signin";
  const error = url.searchParams.get("error");
  const showGithub = hasGithubOAuthConfigured();

  const formAction =
    mode === "signup" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email";

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: "4rem 1.5rem",
        maxWidth: 420,
        margin: "0 auto",
      }}
    >
      <h1
        style={{
          fontSize: "1.5rem",
          marginBottom: "0.25rem",
          textAlign: "center",
        }}
      >
        {mode === "signup" ? "Create an account" : "Sign in to Wrightful"}
      </h1>
      <p
        style={{
          color: "#6b7280",
          textAlign: "center",
          marginBottom: "1.5rem",
        }}
      >
        {mode === "signup"
          ? "Set up a password to get started."
          : "Welcome back."}
      </p>

      {error && (
        <p
          style={{
            color: "#991b1b",
            background: "#fef2f2",
            padding: "0.5rem 0.75rem",
            borderRadius: "4px",
            marginBottom: "1rem",
            fontSize: "0.875rem",
          }}
        >
          {error}
        </p>
      )}

      <form
        method="post"
        action={formAction}
        style={{ display: "grid", gap: "0.75rem", marginBottom: "1rem" }}
      >
        <input type="hidden" name="callbackURL" value={next} />
        {mode === "signup" && (
          <label>
            <span style={{ display: "block", fontSize: "0.85rem" }}>Name</span>
            <input
              name="name"
              required
              maxLength={80}
              style={{ padding: "0.5rem", width: "100%" }}
            />
          </label>
        )}
        <label>
          <span style={{ display: "block", fontSize: "0.85rem" }}>Email</span>
          <input
            name="email"
            type="email"
            required
            style={{ padding: "0.5rem", width: "100%" }}
          />
        </label>
        <label>
          <span style={{ display: "block", fontSize: "0.85rem" }}>
            Password
          </span>
          <input
            name="password"
            type="password"
            required
            minLength={8}
            style={{ padding: "0.5rem", width: "100%" }}
          />
        </label>
        <button
          type="submit"
          style={{
            padding: "0.6rem 1rem",
            background: "#111827",
            color: "#fff",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "0.95rem",
          }}
        >
          {mode === "signup" ? "Create account" : "Sign in"}
        </button>
      </form>

      <p style={{ textAlign: "center", fontSize: "0.875rem" }}>
        {mode === "signup" ? (
          <>
            Have an account?{" "}
            <a href={`/login?next=${callbackURL}`} style={{ color: "#2563eb" }}>
              Sign in
            </a>
          </>
        ) : (
          <>
            New to Wrightful?{" "}
            <a
              href={`/login?mode=signup&next=${callbackURL}`}
              style={{ color: "#2563eb" }}
            >
              Create an account
            </a>
          </>
        )}
      </p>

      {showGithub && (
        <>
          <div
            style={{
              textAlign: "center",
              margin: "1.5rem 0 1rem",
              color: "#9ca3af",
              fontSize: "0.8rem",
            }}
          >
            — or —
          </div>
          <a
            href={githubHref}
            style={{
              display: "block",
              padding: "0.6rem 1rem",
              background: "#fff",
              color: "#111827",
              border: "1px solid #d1d5db",
              textDecoration: "none",
              borderRadius: "6px",
              textAlign: "center",
              fontSize: "0.95rem",
            }}
          >
            Continue with GitHub
          </a>
        </>
      )}
    </div>
  );
}
