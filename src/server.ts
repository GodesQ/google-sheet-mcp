// server.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import {z} from "zod";
import {GoogleSpreadsheet} from "google-spreadsheet";
import {OAuth2Client, JWT} from "google-auth-library";
import dotenv from "dotenv";
import {googleSheets} from "./data/sheets.js";
import {decryptToken} from "./crypto.js";
dotenv.config();

const googlePrivateKey = process.env.GOOGLE_PRIVATE_KEY;
if (!googlePrivateKey) {
    throw new Error(
        "GOOGLE_PRIVATE_KEY environment variable is not set"
    );
}

const googleServiceEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
if (!googleServiceEmail) {
    throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_EMAIL environment variable is not set"
    );
}

/**
 * =========================
 *  CONFIG & ENV VALIDATION
 * =========================
 *
 * Scalable pattern:
 * - Supports static env JSON registry or per-type env vars.
 * - Strong validation + clear error surfaces.
 */
const ENV = z
    .object({
        GOOGLE_SERVICE_ACCOUNT_EMAIL: z
            .string()
            .default(googleServiceEmail)
            .describe("Service account email for Google Sheets API"),
        GOOGLE_PRIVATE_KEY: z
            .string()
            .default(googlePrivateKey)
            .transform((key) => key.replace(/\\n/g, "\n"))
            .describe(
                "Service account private key; ensure correct format"
            ),
        /**
         * Optional: JSON blob describing sheets registry:
         * [
         *   {"type":"invoices","sheetId":"...","tabTitle":"invoices"},
         *   {"type":"sales","sheetId":"...","tabTitle":"sales"}
         * ]
         */
        GOOGLE_SHEETS_REGISTRY: z.string().optional(),
        // Backward-compatible optional envs for quick setups:
        SHEET_ID_INVOICES: z.string().optional(),
        SHEET_ID_SALES: z.string().optional(),
        SHEET_ID_MARKETING: z.string().optional(),
        SHEET_ID_CLIENTS: z.string().optional(),
        SHEET_ID_TASKS: z.string().optional(),
        SHEET_ID_PROJECTS: z.string().optional(),
        SHEET_ID_EMPLOYEES: z.string().optional(),
        DATA_SOURCES_API_BASE_URL: z.string().optional(),
    })
    .parse(process.env as any);

// Backend API base for data-sources
// Prefer explicit DATA_SOURCES_API_BASE_URL, fallback to BACKEND_URL, then local default
const DATA_SOURCES_API_BASE_URL =
    ENV.DATA_SOURCES_API_BASE_URL ||
    process.env.BACKEND_URL ||
    "https://688dd0c04f88.ngrok-free.app";

// Small utility to add fetch timeouts
function fetchWithTimeout(
    resource: string,
    options: RequestInit & {timeoutMs?: number} = {}
) {
    const {timeoutMs = 10000, ...rest} = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(resource, {
        ...rest,
        signal: controller.signal,
    }).finally(() => clearTimeout(id));
}

type SheetType =
    | "invoices"
    | "sales"
    | "marketing"
    | "clients"
    | "tasks"
    | "projects"
    | "employees";

type SheetRegistryEntry = {
    type: SheetType;
    sheetId: string;
    /** Optional: specify a tab title; defaults to `type` */
    tabTitle?: string;
};

/**
 * Extracted data shapes from the Data Sources API
 */
type ExtractedSpreadsheet = {
    id: string;
    url: string;
    category?: string | null;
};

type ExtractedDataSource = {
    id?: string;
    tenant_id?: string | number;
    name?: string;
    type?: string;
    oauth: {
        access_token: string;
        refresh_token: string;
    } | null;
    spreadsheets: ExtractedSpreadsheet[];
};

/** Safely extract OAuth + spreadsheets from server response */
function extractGoogleSheetsConfigs(
    responseData: any
): ExtractedDataSource[] {
    const sources = Array.isArray(responseData?.data)
        ? responseData.data
        : [];

    return sources.map((src: any): ExtractedDataSource => {
        const oauth = src?.config_data?.oauth ?? null;
        const spreadsheetsRaw = Array.isArray(
            src?.config_data?.spreadsheets
        )
            ? src.config_data.spreadsheets
            : [];
        const spreadsheets: ExtractedSpreadsheet[] = spreadsheetsRaw
            .filter((s: any) => s && (s.id || s.url))
            .map((s: any) => ({
                id: String(s.id ?? ""),
                url: String(s.url ?? ""),
                category: s.category ?? null,
            }));

        return {
            id: src?.id,
            tenant_id: src?.tenant_id,
            name: src?.name,
            type: src?.type,
            oauth:
                oauth && typeof oauth === "object"
                    ? {
                          access_token: String(
                              oauth.access_token ?? ""
                          ),
                          refresh_token: String(
                              oauth.refresh_token ?? ""
                          ),
                      }
                    : null,
            spreadsheets,
        };
    });
}

/** Centralized auth client (service account) */
const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"], // full access
});

/**
 * =========================
 *  GOOGLE SHEETS HELPERS
 * =========================
 */

function normalizeHeaderResolver(headers: string[]) {
    const normalized = headers.map((h) => h.trim().toLowerCase());
    return (name: string): string | null => {
        const idx = normalized.indexOf(name.trim().toLowerCase());
        return idx >= 0 ? headers[idx] : null;
    };
}

/**
 * =========================
 *  TOOL: manage-sheet-data
 * =========================
 *
 * Operations:
 * - add: insert a row (object of header -> value)
 * - update: update a row by 1-based index with cell updates
 * - delete: delete a row by 1-based index
 * - read: list rows with optional filters, select, limit/offset
 */

const ManageSheetParamsSchema = z.object({
    business_sector_type: z.enum([
        "invoices",
        "sales",
        "marketing",
        "clients",
        "tasks",
        "projects",
        "employees",
    ]),
    operation: z.enum(["add", "update", "delete", "read"]),

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
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
    accessToken: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
    // Prefer encrypted token bundle; keep appAuthToken optional for BC
    encryptedToken: z
        .object({
            enc: z.string().min(1),
            iv: z.string().min(1),
            tag: z.string().min(1),
        })
        .optional(),
    appAuthToken: z.string().min(1).optional(),
    tenantId: z.string().min(1),
});

export type ManageSheetParams = z.infer<
    typeof ManageSheetParamsSchema
>;

export async function executeManageSheetData(
    params: ManageSheetParams
) {
    const {
        business_sector_type,
        operation,
        newRow,
        rowIndex,
        cellUpdates,
        select,
        filter,
        limit = 100,
        offset = 0,
        accessToken,
        refreshToken,
        encryptedToken,
        appAuthToken,
        tenantId,
    } = ManageSheetParamsSchema.parse(params);

    // Determine the effective app auth token
    const effectiveAppAuthToken = encryptedToken
        ? decryptToken(encryptedToken)
        : appAuthToken;

    if (!effectiveAppAuthToken) {
        console.log(
            "Missing app auth token (encryptedToken or appAuthToken required)"
        );
        throw new Error(
            "Missing app auth token (encryptedToken or appAuthToken required)"
        );
    }

    const dataSourcesResult = await fetchGoogleSheetsDataSource(
        effectiveAppAuthToken,
        tenantId
    );

    if (dataSourcesResult.status === "failed") {
        return {
            success: false,
            message: dataSourcesResult.message,
            line: dataSourcesResult.line ?? 326,
        };
    }

    // Try to find a sheetId from fetched data sources by matching the category to business_sector_type
    const extractedSources = dataSourcesResult.extractedSources ?? [];
    const dynamicMatch = extractedSources
        .flatMap((s) => s.spreadsheets)
        .find((sp) => (sp.category ?? "") === business_sector_type);

    const matchedSheet = dynamicMatch
        ? {type: business_sector_type, sheetId: dynamicMatch.id}
        : googleSheets.find((s) => s.type === business_sector_type);

    if (!matchedSheet)
        return {
            success: false,
            message: "Unknown sheet type",
            line: 344,
        };

    let doc: GoogleSpreadsheet;

    // Prefer OAuth2 credentials from params; fall back to first data source oauth if available
    const effectiveAccessToken =
        accessToken ??
        extractedSources.find((s) => s.oauth)?.oauth?.access_token;
    const effectiveRefreshToken =
        refreshToken ??
        extractedSources.find((s) => s.oauth)?.oauth?.refresh_token;

    // If access token is provided, use OAuth2 flow
    if (effectiveAccessToken && effectiveRefreshToken) {
        const oauth2Client = new OAuth2Client({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            redirectUri: `http://localhost:3000/api/auth/callback/google`,
        });

        // Set the credentials with refresh token
        oauth2Client.setCredentials({
            access_token: effectiveAccessToken,
            refresh_token: effectiveRefreshToken,
        });

        // Get a fresh access token (will auto-refresh using refresh_token if needed)
        let {token: initialToken} =
            await oauth2Client.getAccessToken();
        // If for some reason we didn't get a token, force a refresh using the refresh token
        if (!initialToken) {
            try {
                // Ensure we only provide the refresh token, letting the library fetch a new access token
                oauth2Client.setCredentials({
                    refresh_token: effectiveRefreshToken,
                });
                const refreshed = await oauth2Client.getAccessToken();
                initialToken = refreshed.token ?? null;
            } catch (e) {
                // no-op; handled below
            }
        }
        if (!initialToken) {
            return {
                success: false,
                message: "Failed to get access token",
                line: 378,
            };
        }

        // Initialize with obtained token
        doc = new GoogleSpreadsheet(matchedSheet.sheetId, {
            token: initialToken,
        });

        // Attempt to load, if unauthorized try one refresh-and-retry cycle
        try {
            await doc.loadInfo();
        } catch (err: any) {
            const status = err?.response?.status || err?.code;
            const message = (
                err instanceof Error ? err.message : String(err)
            ).toLowerCase();
            const isUnauthorized =
                status === 401 ||
                message.includes("401") ||
                message.includes("unauthorized") ||
                message.includes("invalid_grant") ||
                message.includes("invalid token") ||
                message.includes("invalid_credentials");

            if (!isUnauthorized) throw err;

            // Force-refresh access token and retry once
            let refreshedToken: string | null = null;
            try {
                oauth2Client.setCredentials({
                    refresh_token: effectiveRefreshToken,
                });
                const refreshed = await oauth2Client.getAccessToken();
                refreshedToken = refreshed.token ?? null;
            } catch (e) {
                // no-op; handled below
            }
            if (!refreshedToken) {
                return {
                    success: false,
                    message:
                        "Failed to refresh access token after 401",
                    line: 413,
                };
            }
            doc = new GoogleSpreadsheet(matchedSheet.sheetId, {
                token: refreshedToken,
            });
            // Retry load once; propagate error if it fails
            await doc.loadInfo();
        }
    } else {
        // Fall back to service account authentication using JWT
        const serviceAccountAuth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: process.env.GOOGLE_PRIVATE_KEY?.replace(
                /\\n/g,
                "\n"
            ),
            scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });

        doc = new GoogleSpreadsheet(
            matchedSheet.sheetId,
            serviceAccountAuth
        );
    }

    // At this point, doc.loadInfo() was already called for OAuth2 path with retry.
    // For service account path, we still need to load here.
    if (!(effectiveAccessToken && effectiveRefreshToken)) {
        await doc.loadInfo();
    }
    const sheet =
        doc.sheetsByTitle[business_sector_type] ??
        doc.sheetsByIndex[0];

    if (operation === "add") {
        if (!newRow)
            return {
                success: false,
                message: "newRow is required for add operation",
                line: 453,
            };
        await sheet.addRow(newRow);
        return {
            success: true,
            message: "Row added successfully",
            newRow,
        };
    }

    if (operation === "update") {
        if (!rowIndex || !cellUpdates || cellUpdates.length === 0) {
            return {
                success: false,
                message:
                    "rowIndex and non-empty cellUpdates are required for update",
                line: 469,
            };
        }
        await sheet.loadHeaderRow();
        const headers: string[] = sheet.headerValues ?? [];
        const resolveHeader = normalizeHeaderResolver(headers);

        const rows = await sheet.getRows();
        const row = rows[rowIndex - 1];
        if (!row)
            return {
                success: false,
                message: `Row ${rowIndex} not found`,
                line: 482,
            };

        for (const {column, value} of cellUpdates) {
            const header = resolveHeader(column);
            if (!header)
                return {
                    success: false,
                    message: `Column "${column}" not found. Available headers: ${headers.join(
                        ", "
                    )}`,
                };
            row.set(header, value);
        }
        await row.save();
        return {
            success: true,
            message: `Row ${rowIndex} updated`,
            updates: cellUpdates,
        };
    }

    if (operation === "delete") {
        if (!rowIndex)
            return {
                success: false,
                message: "rowIndex is required for delete",
                line: 509,
            };
        const rows = await sheet.getRows();
        const row = rows[rowIndex - 1];
        if (!row)
            return {
                success: false,
                message: `Row ${rowIndex} not found`,
                line: 517,
            };
        await row.delete();
        return {success: true, message: `Row ${rowIndex} deleted`};
    }

    if (operation === "read") {
        await sheet.loadHeaderRow();
        const headers: string[] = sheet.headerValues ?? [];
        const resolveHeader = normalizeHeaderResolver(headers);

        const rows = await sheet.getRows({
            limit: Math.min(limit + offset, 1000),
        }); // guardrails
        // Lightweight row -> object
        const mapped = rows.map((r: any) => {
            const obj: Record<string, string> = {};
            for (const h of headers)
                obj[h] = (r.get(h) ?? "").toString();
            return obj;
        });

        const result = {
            sheetTitle: sheet.title,
            rowCount: mapped.length,
            headers,
            rows: mapped,
        };

        return result;
    }

    return {success: false, message: "Invalid operation", line: 549};
}

export async function fetchGoogleSheetsDataSource(
    appAuthToken: string,
    tenantId: string | null
) {
    try {
        const url = `https://688dd0c04f88.ngrok-free.app/api/v1/tenants/${tenantId}/data-sources/google-sheets`;
        const response = await fetch(url, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${appAuthToken}`,
                accept: "application/json",
            },
        });

        const text = await response.text();
        let data: any;
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = {raw: text};
        }

        if (!response.ok) {
            const statusInfo = `HTTP ${response.status}${
                response.statusText ? ` ${response.statusText}` : ""
            }`;
            const msg =
                data?.message || data?.error || JSON.stringify(data);
            return {
                status: "failed",
                message: `Data-sources request failed: ${statusInfo} - ${msg}`,
                line: 578,
            };
        }

        const extractedSources = extractGoogleSheetsConfigs(data);

        return {
            status: "success",
            responseData: data,
            extractedSources,
        };
    } catch (error) {
        console.error(
            "Error fetching Google Sheets data source from",
            `${DATA_SOURCES_API_BASE_URL}`,
            "tenant:",
            tenantId,
            "details:",
            error
        );
        return {
            status: "failed",
            message:
                error instanceof Error
                    ? error.message
                    : "Unknown error",
            line: 602,
        };
    }
}
