import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LOCK_PATH = fileURLToPath(
  new URL("../.auth/monitor-scheduler.lock", import.meta.url),
);
const RETRY_DELAY_MS = 50;
const ACQUIRE_TIMEOUT_MS = 60_000;
const STALE_AFTER_MS = 5 * 60_000;

/**
 * Cross-worker lease for tests that advance the dashboard's global monitor
 * scheduler. Playwright workers are separate Node processes, so an in-memory
 * mutex cannot protect the shared preview/database; atomic `open("wx")` can.
 */
export async function acquireMonitorSchedulerLease(): Promise<
  () => Promise<void>
> {
  await mkdir(dirname(LOCK_PATH), { recursive: true });
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const token = `${process.pid}:${randomUUID()}`;
    try {
      await writeFile(LOCK_PATH, token, { encoding: "utf8", flag: "wx" });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const owner = await readFile(LOCK_PATH, "utf8").catch(() => null);
        if (owner === token) await rm(LOCK_PATH, { force: true });
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;

      const owner = await readFile(LOCK_PATH, "utf8").catch(() => null);
      const lockStat = await stat(LOCK_PATH).catch(() => null);
      if (
        !ownerProcessIsAlive(owner) ||
        (lockStat && Date.now() - lockStat.mtimeMs > STALE_AFTER_MS)
      ) {
        await rm(LOCK_PATH, { force: true });
        continue;
      }
      await delay(RETRY_DELAY_MS);
    }
  }

  const owner = await readFile(LOCK_PATH, "utf8").catch(() => "unknown");
  throw new Error(
    `Timed out waiting for the monitor scheduler lease (owner: ${owner})`,
  );
}

/** Remove a lock left behind by a worker killed before fixture teardown. */
export async function clearMonitorSchedulerLease(): Promise<void> {
  await rm(LOCK_PATH, { force: true });
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function ownerProcessIsAlive(owner: string | null): boolean {
  const pid = Number(owner?.split(":", 1)[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
