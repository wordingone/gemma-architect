/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DRAFTER_ONNX_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
