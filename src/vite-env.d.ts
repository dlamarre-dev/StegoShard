/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** OAuth client id for the optional Google Photos destination (may be empty). */
  readonly STEGOSHARD_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
