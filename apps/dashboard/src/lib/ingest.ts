/**
 * Stable public surface for the streaming ingest pipeline.
 *
 * Implementation is split by responsibility under `./ingest/`; routes and
 * consumers continue importing from `@/lib/ingest`.
 */
export * from "./ingest/finalization";
export * from "./ingest/lifecycle";
export * from "./ingest/primitives";
export * from "./ingest/results";
export * from "./ingest/stale-runs";
