// Minimal WebGPU type shim for navigator.gpu.
// Covers only the surface used by agent-harness.ts P10-4 (VRAM ceiling check).
// Full @webgpu/types is not added to avoid inflating devDeps for a probe-only path.

interface GPUAdapterLimits {
  readonly maxBufferSize?: number;
  readonly maxStorageBufferBindingSize?: number;
  [key: string]: number | undefined;
}

interface GPUAdapter {
  readonly limits: GPUAdapterLimits;
  requestDevice(): Promise<GPUDevice>;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface GPUDevice {}

interface GPU {
  requestAdapter(options?: { powerPreference?: "low-power" | "high-performance" }): Promise<GPUAdapter | null>;
}

interface Navigator {
  readonly gpu?: GPU;
}
