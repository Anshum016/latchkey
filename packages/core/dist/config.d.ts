import type { LatchkeyConfig } from "./types.js";
export declare function getLatchkeyHomeDir(): string;
export declare function getDefaultProjectConfigPath(): string;
export declare function getDefaultLegacyConfigPath(): string;
export declare function getDefaultConfigPath(): string;
export declare function getDefaultDatabasePath(): string;
export declare function loadConfig(configPath?: string): LatchkeyConfig;
export declare function saveConfig(config: Partial<LatchkeyConfig>, configPath?: string): LatchkeyConfig;
//# sourceMappingURL=config.d.ts.map