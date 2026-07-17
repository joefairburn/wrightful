import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { isReplayedDelivery } from "@/lib/github-http";

function fakeCacheStorage(): CacheStorage {
  const stores = new Map<string, Map<string, Response>>();
  const openCache = (name: string) => {
    let store = stores.get(name);
    if (!store) {
      store = new Map();
      stores.set(name, store);
    }
    const bucket = store;
    return {
      match: (req: Request) => Promise.resolve(bucket.get(req.url)),
      put: (req: Request, res: Response) => {
        bucket.set(req.url, res);
        return Promise.resolve();
      },
    };
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal structural fake; the guard only calls open/match/put
  return { open: (name: string) => Promise.resolve(openCache(name)) } as never;
}

const globals = globalThis as { caches?: CacheStorage };
let originalCaches: CacheStorage | undefined;

describe("isReplayedDelivery", () => {
  beforeEach(() => {
    originalCaches = globals.caches;
    globals.caches = fakeCacheStorage();
  });

  afterEach(() => {
    if (originalCaches === undefined) {
      delete globals.caches;
    } else {
      globals.caches = originalCaches;
    }
  });

  it("lets a first-seen delivery id through and flags its replay", async () => {
    expect(await isReplayedDelivery("d-1")).toBe(false);
    expect(await isReplayedDelivery("d-1")).toBe(true);
  });

  it("tracks delivery ids independently", async () => {
    expect(await isReplayedDelivery("d-1")).toBe(false);
    expect(await isReplayedDelivery("d-2")).toBe(false);
    expect(await isReplayedDelivery("d-1")).toBe(true);
    expect(await isReplayedDelivery("d-2")).toBe(true);
  });

  it("cannot dedup a missing/empty id (GitHub always sends one on real deliveries)", async () => {
    expect(await isReplayedDelivery(null)).toBe(false);
    expect(await isReplayedDelivery(undefined)).toBe(false);
    expect(await isReplayedDelivery("")).toBe(false);
  });

  it("fails open when no Cache API exists (non-Worker contexts)", async () => {
    delete globals.caches;
    expect(await isReplayedDelivery("d-1")).toBe(false);
    expect(await isReplayedDelivery("d-1")).toBe(false);
  });
});
