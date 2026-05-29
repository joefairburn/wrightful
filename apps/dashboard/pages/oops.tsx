import { Link } from "@void/react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * Generic 500 page. The error middleware rewrites here after catching an
 * unhandled exception from a downstream handler.
 */
export default function OopsPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Something went wrong</EmptyTitle>
          <EmptyDescription>
            An unexpected error stopped this page from rendering. We&apos;ve
            logged it — try again in a moment.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button render={<Link href="/">Back to dashboard</Link>} />
        </EmptyContent>
      </Empty>
    </main>
  );
}
