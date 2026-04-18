import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { DockerUpstreamServerConfig, UpstreamServerConfig } from "@latchkey/core";
export declare function buildDockerRunArgs(upstream: DockerUpstreamServerConfig, projectDir?: string): string[];
export declare function buildUpstreamTransportConfig(upstream: UpstreamServerConfig, projectDir?: string): StdioServerParameters;
//# sourceMappingURL=upstream.d.ts.map