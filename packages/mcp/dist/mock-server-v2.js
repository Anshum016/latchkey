import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "mock-server", version: "0.1.0" });
server.registerTool("delete_email", {
    description: "Delete an email by ID",
    inputSchema: {
        id: z.string(),
        permanent: z.boolean().optional()
    }
}, async ({ id, permanent }) => ({
    content: [{ type: "text", text: `Deleted email ${id}${permanent ? " (permanent)" : ""}` }]
}));
server.registerTool("send_email", {
    description: "Send an email",
    inputSchema: {
        to: z.string(),
        subject: z.string(),
        body: z.string()
    }
}, async ({ to }) => ({
    content: [{ type: "text", text: `Email sent to ${to}` }]
}));
server.registerTool("read_email", {
    description: "Read an email by ID",
    inputSchema: {
        id: z.string()
    }
}, async ({ id }) => ({
    content: [
        {
            type: "text",
            text: JSON.stringify({ id, from: "sender@example.com", subject: "Test", body: "Hello world" })
        }
    ]
}));
const transport = new StdioServerTransport();
await server.connect(transport);
