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
import {sessionManager} from "../src/sessionManager.js";
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
let isServerlessEnvironment = process.env.VERCEL === "1";

// Cleanup old sessions periodically (older than 30 minutes)
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds

// Only run cleanup if not in serverless environment
if (!isServerlessEnvironment) {
    setInterval(async () => {
        await sessionManager.cleanupExpiredSessions();
    }, 5 * 60 * 1000); // Check every 5 minutes
}

// Helper function to create MCP server with tool registration
const createMcpServer = () => {
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
                    "users",
                    "attendances",
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
                    .describe("Column:value pairs for adding a row"),

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
                limit: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .default(100),
                offset: z.number().int().nonnegative().optional(),
                // Auth/context
                tenantId: z.string().min(1),
                encryptedToken: z
                    .object({
                        enc: z.string().min(1),
                        iv: z.string().min(1),
                        tag: z.string().min(1),
                    })
                    .optional(),
                // Backward compatibility (not recommended)
                appAuthToken: z.string().min(1).optional(),
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

    return server;
};

// Handle POST requests for client-to-server communication
app.post("/mcp", async (req, res) => {
    // Check for existing session ID
    const sessionId = req.headers["mcp-session-id"] as
        | string
        | undefined;
    let transport: StreamableHTTPServerTransport | undefined;

    try {
        // For serverless environments, we'll create a new session if needed
        if (sessionId && transports[sessionId]) {
            // Reuse existing transport if available in current request
            transport = transports[sessionId];
            console.log(
                `Reusing existing transport for session: ${sessionId}`
            );
        } else if (
            sessionId &&
            (await sessionManager.sessionExists(sessionId))
        ) {
            // Session exists in Redis but transport not in memory - recreate transport
            console.log(
                `Session exists in Redis, recreating transport: ${sessionId}`
            );

            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => sessionId,
                onsessioninitialized: async (
                    initializedSessionId
                ) => {
                    if (transport) {
                        transports[initializedSessionId] = transport;
                    }
                    // Update session access time
                    await sessionManager.updateSession(
                        initializedSessionId
                    );
                    console.log(
                        `Recreated transport for existing session: ${initializedSessionId}`
                    );
                },
                enableDnsRebindingProtection: false,
            });

            // Clean up transport when closed
            const currentTransport = transport;
            currentTransport.onclose = async () => {
                if (currentTransport?.sessionId) {
                    delete transports[currentTransport.sessionId];
                    console.log(
                        `Closed transport for session: ${currentTransport.sessionId}`
                    );
                }
            };

            const server = createMcpServer();
            await server.connect(transport);
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // New initialization request
            const newSessionId = randomUUID();
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => newSessionId,
                onsessioninitialized: async (
                    initializedSessionId
                ) => {
                    // Store the transport by session ID
                    if (transport) {
                        transports[initializedSessionId] = transport;
                    }
                    // Create session in Redis
                    await sessionManager.createSession(
                        initializedSessionId
                    );
                    console.log(
                        `Created new session: ${initializedSessionId}`
                    );
                },
                // DNS rebinding protection is disabled by default for backwards compatibility
                enableDnsRebindingProtection: false,
            });

            // Clean up transport when closed
            const currentTransport = transport;
            currentTransport.onclose = async () => {
                if (currentTransport?.sessionId) {
                    // Delete session after timeout
                    setTimeout(async () => {
                        await sessionManager.deleteSession(
                            currentTransport.sessionId!
                        );
                        delete transports[
                            currentTransport.sessionId!
                        ];
                        console.log(
                            `Closed session: ${currentTransport.sessionId}`
                        );
                    }, SESSION_TIMEOUT);
                }
            };

            const server = createMcpServer();
            await server.connect(transport);
        } else if (sessionId && isServerlessEnvironment) {
            // In serverless environment, if session ID is provided but not found in Redis,
            // create a new session with the same ID to maintain continuity
            console.log(
                `Serverless environment: Creating new session with provided ID: ${sessionId}`
            );

            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => sessionId,
                onsessioninitialized: async (
                    initializedSessionId
                ) => {
                    if (transport) {
                        transports[initializedSessionId] = transport;
                    }
                    await sessionManager.createSession(
                        initializedSessionId
                    );
                    console.log(
                        `Recreated session in serverless environment: ${initializedSessionId}`
                    );
                },
                enableDnsRebindingProtection: false,
            });

            // Clean up transport when closed
            const currentTransport = transport;
            currentTransport.onclose = async () => {
                if (currentTransport?.sessionId) {
                    delete transports[currentTransport.sessionId];
                    console.log(
                        `Closed transport in serverless environment: ${currentTransport.sessionId}`
                    );
                }
            };

            const server = createMcpServer();
            await server.connect(transport);
        } else {
            // Invalid request - provide more detailed error information
            const errorMessage = sessionId
                ? `Session ID provided but not found: ${sessionId}`
                : "No session ID provided and not an initialization request";

            console.log(`Session error: ${errorMessage}`);
            console.log(
                `Available in-memory sessions: ${Object.keys(
                    transports
                ).join(", ")}`
            );
            console.log(
                `Is serverless environment: ${isServerlessEnvironment}`
            );

            res.status(400).json({
                jsonrpc: "2.0",
                error: {
                    code: -32000,
                    message: `Bad Request: ${errorMessage}${
                        isServerlessEnvironment
                            ? " (Serverless environment - sessions may be lost on cold starts)"
                            : ""
                    }`,
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
                    message:
                        "Bad Request: Failed to create or find transport",
                },
                id: null,
            });
        }
    } catch (error) {
        console.error("Error handling MCP request:", error);
        res.status(500).json({
            jsonrpc: "2.0",
            error: {
                code: -32603,
                message:
                    "Internal error: " +
                    (error instanceof Error
                        ? error.message
                        : "Unknown error"),
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
        res.status(400).send(
            `Invalid or missing session ID: ${errorMessage}`
        );
        return;
    }

    // Check if transport exists in current request
    if (!transports[sessionId]) {
        // Check if session exists in Redis
        const sessionExists = await sessionManager.sessionExists(
            sessionId
        );
        if (!sessionExists) {
            const errorMessage = `Session ID provided but not found: ${sessionId}`;
            console.log(`Session request error: ${errorMessage}`);
            res.status(400).send(
                `Invalid or missing session ID: ${errorMessage}`
            );
            return;
        }

        // Session exists in Redis but transport not in memory - recreate transport
        console.log(`Recreating transport for session: ${sessionId}`);

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => sessionId,
            onsessioninitialized: async (initializedSessionId) => {
                transports[initializedSessionId] = transport;
                await sessionManager.updateSession(
                    initializedSessionId
                );
                console.log(
                    `Recreated transport for session: ${initializedSessionId}`
                );
            },
            enableDnsRebindingProtection: false,
        });

        const server = createMcpServer();
        await server.connect(transport);

        await transport.handleRequest(req, res);
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
        const sessionInfo = redisSessions.map((session) => ({
            sessionId: session.sessionId,
            createdAt: new Date(session.createdAt).toISOString(),
            lastAccessed: new Date(
                session.lastAccessed
            ).toISOString(),
            age: Date.now() - session.lastAccessed,
            active: true,
            inMemory: transports[session.sessionId] ? true : false,
        }));

        res.json({
            activeSessions: sessionInfo,
            totalSessions: sessionInfo.length,
            inMemorySessions: Object.keys(transports).length,
            serverTime: new Date().toISOString(),
            environment: {
                isServerless: isServerlessEnvironment,
                platform: process.env.VERCEL ? "Vercel" : "Local",
                nodeEnv: process.env.NODE_ENV,
                storageType: sessionManager.getStorageType(),
            },
            warning: isServerlessEnvironment
                ? "Sessions may be lost on cold starts in serverless environment"
                : null,
        });
    } catch (error) {
        console.error("Error in debug endpoint:", error);
        res.status(500).json({
            error: "Failed to get session information",
            details:
                error instanceof Error
                    ? error.message
                    : "Unknown error",
        });
    }
});

// Redis connection test endpoint
app.get("/debug/redis", async (req, res) => {
    try {
        const isConnected =
            await sessionManager.testRedisConnection();
        res.json({
            redisConnected: isConnected,
            storageType: sessionManager.getStorageType(),
            environment: {
                hasRedisUrl: !!process.env.UPSTASH_REDIS_REST_URL,
                hasRedisToken: !!process.env.UPSTASH_REDIS_REST_TOKEN,
                isServerless: isServerlessEnvironment,
            },
        });
    } catch (error) {
        console.error("Error testing Redis connection:", error);
        res.status(500).json({
            error: "Failed to test Redis connection",
            details:
                error instanceof Error
                    ? error.message
                    : "Unknown error",
        });
    }
});

// Export for Vercel serverless
export default app;
