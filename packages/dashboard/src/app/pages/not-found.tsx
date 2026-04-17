import { requestInfo } from "rwsdk/worker";

export function NotFoundPage() {
  requestInfo.response.status = 404;
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Not found</h1>
      <p style={{ color: "#6b7280" }}>
        This page doesn&apos;t exist, or you don&apos;t have access to it.
      </p>
      <a href="/">Back home</a>
    </div>
  );
}
