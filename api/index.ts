import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { executeManageSheetData, ManageSheetParams } from "../src/server.js";
import cors from "cors";

const app = express();
app.use(express.json());

// Serve static files from the public directory
app.use(express.static("public"));

// Add CORS middleware before your MCP routes
app.use(
    cors({
        origin: "*", // Configure appropriately for production
        exposedHeaders: ["Mcp-Session-Id"],
        allowedHeaders: ["Content-Type", "mcp-session-id"],
    })
);

// Map to store transports by session ID
const transports: {
    [sessionId: string]: StreamableHTTPServerTransport;
} = {};

// Handle POST requests for client-to-server communication
app.post("/mcp", async (req, res) => {
    // Check for existing session ID
    const sessionId = req.headers["mcp-session-id"] as
        | string
        | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
                // Store the transport by session ID
                transports[sessionId] = transport;
            },
            // DNS rebinding protection is disabled by default for backwards compatibility
            enableDnsRebindingProtection: false,
        });

        // Clean up transport when closed
        transport.onclose = () => {
            if (transport.sessionId) {
                delete transports[transport.sessionId];
            }
        };

        const server = new McpServer({
            name: "sheets-mcp-server",
            version: "1.0.0",
        });

        // Register the manage-sheet tool
        server.registerTool(
            "manage-sheet",
            {
                title: "Manage Google Sheets",
                description:
                    "Create, read, update, and delete Google Sheets Business Sector like (invoices, tasks, employees, clients, sales, projects).",
                inputSchema: {
                    business_sector_type: z.enum([
                        "invoices",
                        "sales",
                        "marketing",
                        "clients",
                        "tasks",
                        "projects",
                        "employees",
                    ]),
                    operation: z.enum([
                        "add",
                        "update",
                        "delete",
                        "read",
                    ]),

                    // add
                    newRow: z
                        .record(z.string(), z.string())
                        .nullable()
                        .optional()
                        .describe(
                            "Column:value pairs for adding a row"
                        ),

                    // update/delete
                    rowIndex: z
                        .number()
                        .int()
                        .positive()
                        .nullable()
                        .optional()
                        .describe("1-based row index"),

                    // update
                    cellUpdates: z
                        .array(
                            z.object({
                                column: z.string(),
                                value: z.string(),
                            })
                        )
                        .nullable()
                        .optional(),

                    // read
                    select: z
                        .array(z.string())
                        .optional()
                        .describe("Columns to include"),
                    filter: z
                        .array(
                            z.object({
                                column: z.string(),
                                op: z
                                    .enum([
                                        "eq",
                                        "neq",
                                        "contains",
                                        "startsWith",
                                        "endsWith",
                                    ])
                                    .default("eq"),
                                value: z.string(),
                            })
                        )
                        .optional(),
                    limit: z.number().int().positive().optional(),
                    offset: z.number().int().nonnegative().optional(),
                },
            },
            async (args) => {
                try {
                    const result = await executeManageSheetData(
                        args as ManageSheetParams
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(result),
                            },
                        ],
                    };
                } catch (err) {
                    throw err;
                }
            }
        );

        // Connect to the MCP server
        await server.connect(transport);
    } else {
        // Invalid request
        res.status(400).json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "Bad Request: No valid session ID provided",
            },
            id: null,
        });
        return;
    }

    // Handle the request
    await transport.handleRequest(req, res, req.body);
});

// Reusable handler for GET and DELETE requests
const handleSessionRequest = async (
    req: express.Request,
    res: express.Response
) => {
    const sessionId = req.headers["mcp-session-id"] as
        | string
        | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
        return;
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
};

// Handle GET requests for server-to-client notifications via SSE
app.get("/mcp", handleSessionRequest);

// Handle DELETE requests for session termination
app.delete("/mcp", handleSessionRequest);

// Health check endpoint - serve the home page
app.get("/", (req, res) => {
    res.sendFile("public/index.html", { root: process.cwd() });
});

// Export for Vercel serverless
export default app;
