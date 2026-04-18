import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
const securityRuleSchema = z.object({
    pattern: z.string().min(1),
    scoreDelta: z.number().int(),
    reason: z.string().min(1)
});
const securityRulesSchema = z.array(securityRuleSchema);
function extractStructuredRulesBlock(content) {
    const commentMatch = content.match(/<!--\s*latchkey-rules:start\s*-->([\s\S]*?)<!--\s*latchkey-rules:end\s*-->/i);
    if (commentMatch?.[1]) {
        return commentMatch[1].trim();
    }
    const fencedMatch = content.match(/```latchkey-rules\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
        return fencedMatch[1].trim();
    }
    return null;
}
export function parseSecurityRules(content) {
    const block = extractStructuredRulesBlock(content);
    if (!block) {
        return [];
    }
    const parsed = JSON.parse(block);
    if (Array.isArray(parsed)) {
        return securityRulesSchema.parse(parsed);
    }
    if (parsed && typeof parsed === "object" && "rules" in parsed) {
        return securityRulesSchema.parse(parsed.rules);
    }
    throw new Error("SECURITY.md rules block must be a JSON array or an object with a 'rules' array.");
}
export function loadSecurityRules(projectDir = process.cwd()) {
    const securityPath = path.join(projectDir, "SECURITY.md");
    if (!fs.existsSync(securityPath)) {
        return [];
    }
    const content = fs.readFileSync(securityPath, "utf-8");
    return parseSecurityRules(content);
}
