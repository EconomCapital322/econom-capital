/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly VITE_API_MODE?: 'api' | 'demo'
}
interface ImportMeta { readonly env: ImportMetaEnv }
