/**
 * Minimal ambient declaration for the `cloudflare:sockets` workerd built-in,
 * used by `tcp-executor.ts`. The full type ships in `@cloudflare/workers-types`,
 * but this app's `tsconfig` narrows `types` to `["void/env"]`, so the global
 * module declaration isn't in scope — and pulling the whole workers-types lib in
 * would change ambient globals across the app. This declares ONLY the
 * `connect()` surface the executor calls; the pure `tcp-run.ts` works against its
 * own structural `TcpSocketLike` and never imports this module.
 *
 * @see https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
 */
declare module "cloudflare:sockets" {
  interface SocketAddress {
    hostname: string;
    port: number;
  }

  interface Socket {
    readonly opened: Promise<unknown>;
    readonly closed: Promise<void>;
    close(): Promise<void>;
  }

  export function connect(
    address: string | SocketAddress,
    options?: { secureTransport?: string; allowHalfOpen?: boolean },
  ): Socket;
}
