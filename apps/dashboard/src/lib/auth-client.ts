/**
 * Browser-side auth client. Void exposes a preconfigured `auth` object via
 * `void/client` (configured with `basePath: "/api/auth"` and the framework's
 * Better Auth client). Re-export under the legacy `authClient` name so
 * existing components don't need new imports.
 */
import { auth } from "void/client";

export const authClient = auth;
