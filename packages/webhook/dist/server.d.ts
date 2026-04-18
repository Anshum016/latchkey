import type { Server } from "node:http";
import { ApprovalService, loadConfig } from "@latchkey/core";
export interface StartWebhookServerOptions {
    port?: number;
    configPath?: string;
    configOverride?: ReturnType<typeof loadConfig>;
    service?: ApprovalService;
}
export declare function startWebhookServer(options?: StartWebhookServerOptions): Promise<Server>;
//# sourceMappingURL=server.d.ts.map