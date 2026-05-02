export function ErrorPage({ error }: { error: unknown }) {
  const message =
    error instanceof Error ? error.message : "An unexpected error occurred.";
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-8 text-center">
        <h1 className="font-semibold text-2xl tracking-tight">
          Something went wrong
        </h1>
        <p className="mt-2 text-muted-foreground text-sm">{message}</p>
        <a
          href="/"
          className="mt-6 inline-block rounded-md border border-border bg-secondary px-4 py-2 font-medium text-secondary-foreground text-sm hover:bg-secondary/80"
        >
          Go home
        </a>
      </div>
    </div>
  );
}
