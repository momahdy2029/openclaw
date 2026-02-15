import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setChatwootRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getChatwootRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Chatwoot runtime not initialized");
  }
  return runtime;
}
