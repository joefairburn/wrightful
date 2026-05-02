import { RouteMiddleware } from "rwsdk/router";

export const setCommonHeaders =
  (): RouteMiddleware =>
  ({ response, rw: { nonce } }) => {
    if (!import.meta.env.VITE_IS_DEV_SERVER) {
      response.headers.set(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains; preload",
      );
    }

    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set(
      "Permissions-Policy",
      "geolocation=(), microphone=(), camera=()",
    );

    // Vite's dev runtime needs 'unsafe-eval' for HMR; production builds don't.
    const scriptSrc = import.meta.env.VITE_IS_DEV_SERVER
      ? `'self' 'unsafe-eval' 'nonce-${nonce}'`
      : `'self' 'nonce-${nonce}'`;

    // `img-src` includes avatars.githubusercontent.com so Better Auth's
    // GitHub-sourced user.image URLs render. `data:` covers any inline pngs
    // (e.g. from a future icon library). Add other provider CDNs here as
    // more OAuth providers are wired up.
    response.headers.set(
      "Content-Security-Policy",
      `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com; font-src 'self'; frame-ancestors 'none'; object-src 'none';`,
    );
  };
