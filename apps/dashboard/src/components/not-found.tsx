import { Link } from "@void/react";

/**
 * 404 page body. Renders when a page loader throws a 404 Response and the
 * surrounding layout still needs to display something — in Void the loader
 * itself throws `new Response("Not Found", { status: 404 })` which short-
 * circuits the render, but components that gate on a missing resource can
 * still mount this directly.
 */
export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-2xl p-6 sm:p-8">
      <h1 className="mb-2 font-semibold text-2xl">Not found</h1>
      <p className="mb-4 text-muted-foreground">
        This page doesn&apos;t exist, or you don&apos;t have access to it.
      </p>
      <Link
        href="/"
        className="text-foreground underline-offset-4 hover:underline"
      >
        Back home
      </Link>
    </div>
  );
}
