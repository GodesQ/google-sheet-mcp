import express from "express";
import {randomUUID} from "node:crypto";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {isInitializeRequest} from "@modelcontextprotocol/sdk/types.js";
import {z} from "zod";
import {executeManageSheetData, ManageSheetParams} from "./server.js";
import cors from "cors";

const app = express();
app.use(express.json());

// Serve static files from the public directory
app.use(express.static("public"));

// Add CORS middleware before your MCP routes
app.use(
    cors({
        origin: "*", // Configure appropriately for production, for example:
        exposedHeaders: ["Mcp-Session-Id"],
        allowedHeaders: ["Content-Type", "mcp-session-id"],
    })
);

// Map to store transports by session ID
const transports: {
    [sessionId: string]: StreamableHTTPServerTransport;
} = {};

// Map to store session creation timestamps for cleanup
const sessionTimestamps: {
    [sessionId: string]: number;
} = {};

// Cleanup old sessions periodically (older than 30 minutes)
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds

setInterval(() => {
    const now = Date.now();
    Object.keys(sessionTimestamps).forEach(sessionId => {
        if (now - sessionTimestamps[sessionId] > SESSION_TIMEOUT) {
            delete transports[sessionId];
            delete sessionTimestamps[sessionId];
            console.log(`Cleaned up expired session: ${sessionId}`);
        }
    });
}, 5 * 60 * 1000); // Check every 5 minutes

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
        // Update timestamp to keep session alive
        sessionTimestamps[sessionId] = Date.now();
    } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
                // Store the transport by session ID
                transports[sessionId] = transport;
                sessionTimestamps[sessionId] = Date.now();
                console.log(`Created new session: ${sessionId}`);
            },
            // DNS rebinding protection is disabled by default for backwards compatibility. If you are running this server
            // locally, make sure to set:
            enableDnsRebindingProtection: false,
        });

        // Clean up transport when closed - but don't immediately delete
        transport.onclose = () => {
            if (transport.sessionId) {
                // Only delete if the session has expired
                const sessionAge = Date.now() - (sessionTimestamps[transport.sessionId] || 0);
                if (sessionAge > SESSION_TIMEOUT) {
                    delete transports[transport.sessionId];
                    delete sessionTimestamps[transport.sessionId];
                    console.log(`Closed session: ${transport.sessionId}`);
                }
            }
        };
        const server = new McpServer({
            name: "sheets-mcp-server",
            version: "1.0.0",
        });

        // ... set up server resources, tools, and prompts ...
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
        // Invalid request - provide more detailed error information
        const errorMessage = sessionId 
            ? `Session ID provided but not found: ${sessionId}` 
            : "No session ID provided and not an initialization request";
        
        console.log(`Session error: ${errorMessage}`);
        console.log(`Available sessions: ${Object.keys(transports).join(', ')}`);
        
        res.status(400).json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: `Bad Request: ${errorMessage}`,
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
        const errorMessage = sessionId 
            ? `Session ID provided but not found: ${sessionId}` 
            : "No session ID provided";
        
        console.log(`Session request error: ${errorMessage}`);
        console.log(`Available sessions: ${Object.keys(transports).join(', ')}`);
        
        res.status(400).send(`Invalid or missing session ID: ${errorMessage}`);
        return;
    }

    // Update timestamp to keep session alive
    sessionTimestamps[sessionId] = Date.now();
    
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
};

// Handle GET requests for server-to-client notifications via SSE
app.get("/mcp", handleSessionRequest);

// Handle DELETE requests for session termination
app.delete("/mcp", handleSessionRequest);

// Health check endpoint - serve the home page
app.get("/", (req, res) => {
    res.sendFile("public/index.html", {root: process.cwd()});
});

// Debug endpoint to check session status
app.get("/debug/sessions", (req, res) => {
    const sessionInfo = Object.keys(transports).map(sessionId => ({
        sessionId,
        createdAt: new Date(sessionTimestamps[sessionId]).toISOString(),
        age: Date.now() - sessionTimestamps[sessionId],
        active: true
    }));
    
    res.json({
        activeSessions: sessionInfo,
        totalSessions: sessionInfo.length,
        serverTime: new Date().toISOString()
    });
});

const PORT = 8123;

app.listen(PORT, (error) => {
    if (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
    console.log(
        `MCP Stateless Streamable HTTP Server listening on port ${PORT}`
    );

    console.log(
        "Google Service Account Email: ",
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
    );
});
