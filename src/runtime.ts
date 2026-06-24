export type RuntimeInfo = {
  readonly name: string;
  readonly version: string;
  readonly node: string;
  readonly environment: string;
};

export function getRuntimeInfo(environment = process.env.NODE_ENV ?? "development"): RuntimeInfo {
  return {
    name: "agent-orchestrator",
    version: "0.0.0",
    node: process.versions.node,
    environment
  };
}
