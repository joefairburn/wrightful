// Invite tokens are bearer credentials: anyone holding the plaintext can join
// the team it's scoped to. The plaintext exists only during the create request
// and in the URL shown to the owner once; only the SHA-256 hash is persisted.
// Lookup on accept re-hashes the URL's token and matches by hash. Mirrors the
// `api_keys.keyHash` pattern in `lib/auth.ts`.

export function generateInviteToken(): string {
  const rand = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...rand))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function hashInviteToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
