/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend base URL baked in at build time; unset means same origin (the dev server proxies /api) */
  readonly VITE_API_URL?: string;
}
