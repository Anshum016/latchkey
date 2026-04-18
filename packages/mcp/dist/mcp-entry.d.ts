import { loadConfig } from "@latchkey/core";
export interface StartMcpProxyServerOptions {
    configPath?: string;
    configOverride?: ReturnType<typeof loadConfig>;
    projectDir?: string;
}
export declare function startMcpProxyServer(options?: StartMcpProxyServerOptions): Promise<void>;
//# sourceMappingURL=mcp-entry.d.ts.map