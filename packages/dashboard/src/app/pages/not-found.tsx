import { requestInfo } from "rwsdk/worker";

export function NotFoundPage() {
  requestInfo.response.status = 404;
  return (
    <div className="mx-auto max-w-2xl p-6 sm:p-8">
      <h1 className="mb-2 font-semibold text-2xl">Not found</h1>
      <p className="mb-4 text-muted-foreground">
        This page doesn&apos;t exist, or you don&apos;t have access to it.
      </p>
      <a
        href="/"
        className="text-foreground underline-offset-4 hover:underline"
      >
        Back home
      </a>
    </div>
  );
}
