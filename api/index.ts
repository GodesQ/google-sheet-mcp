import express from "express";
import {randomUUID} from "node:crypto";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {isInitializeRequest} from "@modelcontextprotocol/sdk/types.js";
import {z} from "zod";
import {
    executeManageSheetData,
    ManageSheetParams,
} from "../src/server.js";
import { sessionManager } from "../src/sessionManager.js";
import cors from "cors";

const app = express();
app.use(express.json());

// Add CORS middleware before your MCP routes
app.use(
    cors({
        origin: "*", // Configure appropriately for production
        exposedHeaders: ["Mcp-Session-Id"],
        allowedHeaders: ["Content-Type", "mcp-session-id"],
    })
);

// Map to store transports by session ID (in-memory for current request)
const transports: {
    [sessionId: string]: StreamableHTTPServerTransport;
} = {};

// For Vercel serverless, we need to handle the fact that memory is not shared between invocations
let isServerlessEnvironment = process.env.VERCEL === '1';

// Cleanup old sessions periodically (older than 30 minutes)
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds

// Only run cleanup if not in serverless environment
if (!isServerlessEnvironment) {
    setInterval(async () => {
        await sessionManager.cleanupExpiredSessions();
    }, 5 * 60 * 1000); // Check every 5 minutes
}

// Handle POST requests for client-to-server communication
app.post("/mcp", async (req, res) => {
    // Check for existing session ID
    const sessionId = req.headers["mcp-session-id"] as
        | string
        | undefined;
    let transport: StreamableHTTPServerTransport | undefined;

    if (sessionId) {
        // Check if session exists in Redis
        const session = await sessionManager.getSession(sessionId);
        if (session && transports[sessionId]) {
            // Reuse existing transport
            transport = transports[sessionId];
            console.log(`Reusing existing session: ${sessionId}`);
        } else if (session) {
            // Session exists in Redis but transport is missing (cold start)
            // Create a new transport for this session
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => sessionId,
                onsessioninitialized: (initializedSessionId) => {
                    if (transport) {
                        transports[initializedSessionId] = transport;
                        console.log(`Recreated transport for existing session: ${initializedSessionId}`);
                    }
                },
                enableDnsRebindingProtection: false,
            });
            
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

            await server.connect(transport);
        }
    }
    
    if (!transport && !sessionId && isInitializeRequest(req.body)) {
        // New initialization request
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: async (sessionId) => {
                // Store the transport by session ID
                if (transport) {
                    transports[sessionId] = transport;
                }
                // Create session in Redis
                await sessionManager.createSession(sessionId);
                console.log(`Created new session: ${sessionId}`);
            },
            // DNS rebinding protection is disabled by default for backwards compatibility
            enableDnsRebindingProtection: false,
        });

        // Clean up transport when closed - but don't immediately delete
        const closedSessionId = transport.sessionId;
        transport.onclose = async () => {
            if (closedSessionId) {
                // Delete session from Redis after timeout
                setTimeout(async () => {
                    await sessionManager.deleteSession(closedSessionId);
                    delete transports[closedSessionId];
                    // 'transport' may be undefined here, so check before accessing sessionId
                    if (transport) {
                        console.log(`Closed session: ${transport.sessionId}`);
                    } else {
                        console.log(`Closed session: ${closedSessionId}`);
                    }
                }, SESSION_TIMEOUT);
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
        // Invalid request - provide more detailed error information
        const errorMessage = sessionId 
            ? `Session ID provided but not found: ${sessionId}` 
            : "No session ID provided and not an initialization request";
        
        console.log(`Session error: ${errorMessage}`);
        console.log(`Available sessions: ${Object.keys(transports).join(', ')}`);
        console.log(`Is serverless environment: ${isServerlessEnvironment}`);
        
        // For serverless environments, suggest creating a new session
        if (isServerlessEnvironment && sessionId) {
            console.log(`Serverless environment detected - session ${sessionId} was lost due to cold start`);
        }
        
        res.status(400).json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: `Bad Request: ${errorMessage}${isServerlessEnvironment ? ' (Serverless environment - sessions may be lost on cold starts)' : ''}`,
            },
            id: null,
        });
        return;
    }

    // Handle the request
    if (transport) {
        await transport.handleRequest(req, res, req.body);
    } else {
        res.status(400).json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "Bad Request: Failed to create or find transport",
            },
            id: null,
        });
    }
});

// Reusable handler for GET and DELETE requests
const handleSessionRequest = async (
    req: express.Request,
    res: express.Response
) => {
    const sessionId = req.headers["mcp-session-id"] as
        | string
        | undefined;
    if (!sessionId) {
        const errorMessage = "No session ID provided";
        console.log(`Session request error: ${errorMessage}`);
        res.status(400).send(`Invalid or missing session ID: ${errorMessage}`);
        return;
    }

    // Check if session exists in Redis
    const session = await sessionManager.getSession(sessionId);
    if (!session || !transports[sessionId]) {
        const errorMessage = session 
            ? `Session exists in Redis but transport not found: ${sessionId}` 
            : `Session ID provided but not found: ${sessionId}`;
        
        console.log(`Session request error: ${errorMessage}`);
        console.log(`Available sessions: ${Object.keys(transports).join(', ')}`);
        
        res.status(400).send(`Invalid or missing session ID: ${errorMessage}`);
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
    res.sendFile("public/index.html", {root: process.cwd()});
});

// Debug endpoint to check session status
app.get("/debug/sessions", async (req, res) => {
    try {
        const redisSessions = await sessionManager.getAllSessions();
        const sessionInfo = redisSessions.map(session => ({
            sessionId: session.sessionId,
            createdAt: new Date(session.createdAt).toISOString(),
            lastAccessed: new Date(session.lastAccessed).toISOString(),
            age: Date.now() - session.lastAccessed,
            active: true,
            inMemory: transports[session.sessionId] ? true : false
        }));
        
        res.json({
            activeSessions: sessionInfo,
            totalSessions: sessionInfo.length,
            inMemorySessions: Object.keys(transports).length,
            serverTime: new Date().toISOString(),
            environment: {
                isServerless: isServerlessEnvironment,
                platform: process.env.VERCEL ? 'Vercel' : 'Local',
                nodeEnv: process.env.NODE_ENV
            },
            warning: isServerlessEnvironment ? "Sessions may be lost on cold starts in serverless environment" : null
        });
    } catch (error) {
        console.error('Error in debug endpoint:', error);
        res.status(500).json({
            error: 'Failed to get session information',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

// Export for Vercel serverless
export default app;
