import { z } from "zod";
type JsonSchema = {
    type?: unknown;
    enum?: unknown;
    items?: unknown;
    properties?: Record<string, unknown> | undefined;
    required?: string[] | undefined;
    description?: unknown;
};
export declare function jsonSchemaToZodShape(schema: JsonSchema): Record<string, z.ZodTypeAny>;
export {};
//# sourceMappingURL=json-schema.d.ts.map