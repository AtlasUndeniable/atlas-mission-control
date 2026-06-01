import { MastraAiSdkRuntimeAdapter } from "./workspace-mastra-runtime-adapter.ts";
import {
  TerminalLocalRuntimeAdapter,
  type WorkspaceLocalRuntimeAdapter,
} from "./workspace-local-runtime-adapter.ts";

export type WorkspaceRuntimeProvider = "mock" | "local-codex" | "mastra";

export function resolveWorkspaceRuntimeProvider(env: NodeJS.ProcessEnv = process.env): WorkspaceRuntimeProvider {
  switch (env.ATLAS_WORKSPACE_DEMO_RUNTIME) {
    case "local-codex":
      return "local-codex";
    case "mastra":
      return "mastra";
    case "mock":
    case undefined:
    case "":
      return "mock";
    default:
      return "mock";
  }
}

export function createWorkspaceRuntimeAdapter(
  provider: WorkspaceRuntimeProvider,
): WorkspaceLocalRuntimeAdapter {
  if (provider === "mastra") return new MastraAiSdkRuntimeAdapter();
  if (provider === "local-codex") {
    return new TerminalLocalRuntimeAdapter({ forcedRunner: "codex" });
  }
  return new TerminalLocalRuntimeAdapter({ forcedMode: "mock" });
}
