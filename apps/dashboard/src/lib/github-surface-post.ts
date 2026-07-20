import { logger } from "void/log";
import { githubFetch } from "@/lib/github-http";

/**
 * The claim-before-POST mechanics shared by both GitHub run surfaces. Each
 * surface stores an external GitHub id (the check-run id on `runs`, the
 * issue-comment id on `githubPrComments`) plus an epoch-seconds claim column
 * CASed on to dedupe concurrent posters. This module owns the ordering —
 * claim the POST slot, re-read after a lost race, release the claim when the
 * POST fails, persist the posted id — while each surface supplies the four
 * single-query operations against its own table.
 */

/** One surface's storage operations for {@link postWithClaimedSlot}. */
export interface ClaimedSlotIO {
  /**
   * CAS-claim the POST slot: succeed only while no external id is recorded
   * and the claim column is null or expired. Returns `nowSeconds` as the
   * claim token, or null when the slot is already held.
   */
  claim(nowSeconds: number): Promise<number | null>;
  /** Re-read the external id after losing the claim race. */
  readId(): Promise<number | null>;
  /** Release this caller's claim (CAS on the token, so only if still ours). */
  release(claim: number): Promise<void>;
  /**
   * Persist the posted id. `claim` is non-null iff this caller holds the
   * slot — the write must CAS on it so a slow winner can't clobber newer
   * state. `existingId` is the id that was PATCHed (null on a fresh POST),
   * letting a surface skip a no-op write.
   */
  persist(
    id: number,
    claim: number | null,
    existingId: number | null,
  ): Promise<void>;
}

/**
 * Run one surface's claim → POST/PATCH → persist sequence. With `initialId`
 * already known the surface PATCHes directly (no claim). Otherwise it claims
 * first; on a lost race it re-reads and PATCHes the winner's id if that has
 * landed, else returns (the winner's in-flight POST covers this completion).
 * A `post` failure releases a held claim — so a retry isn't blocked for the
 * claim TTL — and rethrows into the surface's own error envelope.
 */
export async function postWithClaimedSlot(
  surface: string,
  runId: string,
  initialId: number | null,
  io: ClaimedSlotIO,
  post: (existingId: number | null) => Promise<number | null>,
): Promise<void> {
  let existingId = initialId;
  let claim: number | null = null;
  if (existingId === null) {
    claim = await io.claim(Math.floor(Date.now() / 1000));
    if (claim === null) {
      existingId = await io.readId();
      if (existingId === null) return;
    }
  }

  let postedId: number | null;
  try {
    postedId = await post(existingId);
  } catch (err) {
    if (claim !== null) {
      await io.release(claim).catch((releaseErr: unknown) => {
        logger.warn(`github ${surface} claim release failed`, {
          runId,
          message:
            releaseErr instanceof Error
              ? releaseErr.message
              : String(releaseErr),
        });
      });
    }
    throw err;
  }
  if (postedId !== null) await io.persist(postedId, claim, existingId);
}

/**
 * Write (POST/PATCH) a GitHub resource and return the `id` from its JSON
 * response — the shape both surfaces persist. Throws on a non-2xx response;
 * returns null when the response carries no id. Lives here (not in
 * `@/lib/github-http`) so it goes through the imported `githubFetch` binding
 * the surface tests mock.
 */
export async function githubWriteId(
  path: string,
  method: "POST" | "PATCH",
  payload: unknown,
  token: string,
  label: string,
): Promise<number | null> {
  const response = await githubFetch(
    path,
    { method, body: JSON.stringify(payload) },
    token,
  );
  if (!response.ok) {
    throw new Error(
      `GitHub ${label} ${method} failed: ${response.status} ${response.statusText}`,
    );
  }
  const json = (await response.json().catch(() => ({}))) as { id?: number };
  return json.id ?? null;
}
