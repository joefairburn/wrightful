function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function presignHandler() {
  // TODO: Implement actual presigned R2 upload URLs in Phase 2
  return jsonResponse(
    { error: "Artifact uploads are not yet implemented" },
    501,
  );
}
