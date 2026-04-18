import { z } from "zod";
function withDescription(schema, description) {
    return typeof description === "string" && description.length > 0 ? schema.describe(description) : schema;
}
function fromJsonSchema(schema) {
    if (!schema || typeof schema !== "object") {
        return z.unknown();
    }
    const jsonSchema = schema;
    if (Array.isArray(jsonSchema.enum)) {
        const values = jsonSchema.enum.filter((value) => typeof value === "string");
        if (values.length > 0) {
            const [first, ...rest] = values;
            return withDescription(z.enum([first, ...rest]), jsonSchema.description);
        }
    }
    const type = jsonSchema.type;
    if (Array.isArray(type)) {
        const nonNull = type.filter((value) => typeof value === "string" && value !== "null");
        const base = fromJsonSchema({ ...jsonSchema, type: nonNull[0] ?? "string" });
        return type.includes("null") ? base.nullable() : base;
    }
    switch (type) {
        case "string":
            return withDescription(z.string(), jsonSchema.description);
        case "number":
            return withDescription(z.number(), jsonSchema.description);
        case "integer":
            return withDescription(z.number().int(), jsonSchema.description);
        case "boolean":
            return withDescription(z.boolean(), jsonSchema.description);
        case "array":
            return withDescription(z.array(fromJsonSchema(jsonSchema.items)), jsonSchema.description);
        case "object":
            if (jsonSchema.properties) {
                return withDescription(z.object(jsonSchemaToZodShape(jsonSchema)), jsonSchema.description);
            }
            return withDescription(z.record(z.string(), z.unknown()), jsonSchema.description);
        default:
            return withDescription(z.unknown(), jsonSchema.description);
    }
}
export function jsonSchemaToZodShape(schema) {
    const shape = {};
    const required = new Set(schema.required ?? []);
    const properties = schema.properties ?? {};
    for (const [key, value] of Object.entries(properties)) {
        const converted = fromJsonSchema(value);
        shape[key] = required.has(key) ? converted : converted.optional();
    }
    return shape;
}
