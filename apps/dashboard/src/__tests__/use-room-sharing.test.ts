import { describe, it, expect, vi } from "vite-plus/test";

/**
 * `subscribeToRoom` (`@/realtime/use-room`) is the ref-counted shared-connection
 * registry under `useRoom`. A run-detail page mounts several live leaves against
 * the SAME room (status glyph, duration, summary tiles, per-test list); the
 * registry must collapse them to ONE WebSocket — opened on the first subscriber,
 * fanned out to all, closed only when the last unsubscribes — so the page holds
 * one connection per room, not one per leaf. Verified here by mocking `void/ws`'s
 * `connect` with a fake socket (no real WS). Keys are unique per test because the
 * registry is a module-level singleton shared across cases in this file.
 */

interface FakeSocket {
  handlers: Set<(event: unknown) => void>;
  closed: boolean;
  on: (type: "message", cb: (event: unknown) => void) => () => void;
  close: () => void;
  emit: (event: unknown) => void;
}

function makeSocket(): FakeSocket {
  const handlers = new Set<(event: unknown) => void>();
  return {
    handlers,
    closed: false,
    on(_type, cb) {
      handlers.add(cb);
      return () => handlers.delete(cb);
    },
    close() {
      this.closed = true;
    },
    emit(event) {
      for (const h of [...handlers]) h(event);
    },
  };
}

const sockets: FakeSocket[] = [];
const connectSpy = vi.fn<
  (path: string, opts: { params: Record<string, string> }) => FakeSocket
>(() => {
  const s = makeSocket();
  sockets.push(s);
  return s;
});

vi.mock("void/ws", () => ({ connect: connectSpy }));

const { subscribeToRoom } = await import("@/realtime/use-room");

const PATH = "/ws/run/:runId";
/** connects recorded for a given runId — robust to the singleton registry. */
const connectsFor = (runId: string) =>
  connectSpy.mock.calls.filter((c) => c[1].params.runId === runId);

describe("subscribeToRoom (shared, ref-counted connections)", () => {
  it("opens ONE socket for multiple subscribers to the same room and fans out", () => {
    const id = "r-share";
    const params = { runId: id };
    const key = `${PATH}|${JSON.stringify(params)}`;
    const got1: unknown[] = [];
    const got2: unknown[] = [];

    const off1 = subscribeToRoom(PATH, params, key, (e) => got1.push(e));
    const off2 = subscribeToRoom(PATH, params, key, (e) => got2.push(e));

    // Two subscribers, ONE underlying socket.
    expect(connectsFor(id)).toHaveLength(1);
    const socket = sockets.find((s) => !s.closed && s.handlers.size > 0)!;

    // A server message reaches BOTH listeners.
    socket.emit({ type: "progress", n: 1 });
    expect(got1).toEqual([{ type: "progress", n: 1 }]);
    expect(got2).toEqual([{ type: "progress", n: 1 }]);

    off1();
    off2();
  });

  it("keeps the socket open until the LAST subscriber leaves, then closes once", () => {
    const id = "r-refcount";
    const params = { runId: id };
    const key = `${PATH}|${JSON.stringify(params)}`;

    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const offA = subscribeToRoom(PATH, params, key, (e) => seenA.push(e));
    const offB = subscribeToRoom(PATH, params, key, (e) => seenB.push(e));
    expect(connectsFor(id)).toHaveLength(1);
    const socket = connectSpy.mock.results.at(-1)!.value as FakeSocket;

    // Drop one subscriber — socket stays open, and the dropped cb stops receiving.
    offA();
    expect(socket.closed).toBe(false);
    socket.emit({ type: "progress", n: 2 });
    expect(seenA).toEqual([]); // A unsubscribed
    expect(seenB).toEqual([{ type: "progress", n: 2 }]);

    // Drop the last — socket closes exactly once.
    offB();
    expect(socket.closed).toBe(true);

    // Double-invoking an unsubscribe is a no-op (StrictMode / re-run safety).
    expect(() => offB()).not.toThrow();
  });

  it("opens a fresh socket per distinct room, and reopens after full teardown", () => {
    const p1 = { runId: "r-distinct-1" };
    const p2 = { runId: "r-distinct-2" };
    const off1 = subscribeToRoom(
      PATH,
      p1,
      `${PATH}|${JSON.stringify(p1)}`,
      () => {},
    );
    const off2 = subscribeToRoom(
      PATH,
      p2,
      `${PATH}|${JSON.stringify(p2)}`,
      () => {},
    );
    // Distinct rooms → distinct sockets.
    expect(connectsFor("r-distinct-1")).toHaveLength(1);
    expect(connectsFor("r-distinct-2")).toHaveLength(1);

    off1();
    // After the last subscriber for r-distinct-1 leaves, re-subscribing reopens.
    const off1b = subscribeToRoom(
      PATH,
      p1,
      `${PATH}|${JSON.stringify(p1)}`,
      () => {},
    );
    expect(connectsFor("r-distinct-1")).toHaveLength(2);

    off1b();
    off2();
  });
});
