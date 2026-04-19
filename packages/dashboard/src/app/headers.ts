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
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set(
      "Permissions-Policy",
      "geolocation=(), microphone=(), camera=()",
    );

    // Vite's dev runtime needs 'unsafe-eval' for HMR; production builds don't.
    const scriptSrc = import.meta.env.VITE_IS_DEV_SERVER
      ? `'self' 'unsafe-eval' 'nonce-${nonce}'`
      : `'self' 'nonce-${nonce}'`;

    response.headers.set(
      "Content-Security-Policy",
      `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'self'; object-src 'none';`,
    );
  };
