import "server-only";
import { localDemoConfig } from "../../packages/ai-insights/src/core";

/** Configuration readiness only: no provider request, credentials or model cross the server boundary. */
export function marketInsightAvailable(env: NodeJS.ProcessEnv, host: string | null): boolean {
  try {
    return host === new URL(localDemoConfig(env).origin).host;
  } catch {
    return false;
  }
}
