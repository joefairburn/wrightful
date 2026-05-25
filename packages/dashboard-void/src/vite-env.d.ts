/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by the void plugin during `vp dev`. Gates dev-only ingest paths. */
  readonly VITE_IS_DEV_SERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.css";
