// server.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import {z} from "zod";
import {GoogleSpreadsheet} from "google-spreadsheet";
import {OAuth2Client, JWT} from "google-auth-library";
import dotenv from "dotenv";
import {googleSheets} from "./data/sheets.js";
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
    })
    .parse(process.env as any);

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
    appAuthToken: z.string().optional(),
});

export type ManageSheetParams = z.infer<
    typeof ManageSheetParamsSchema
>;

/** Core executor for manage-sheet-data (safe to call from MCP handler) */
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
        appAuthToken,
    } = ManageSheetParamsSchema.parse(params);

    const matchedSheet = googleSheets.find(
        (s) => s.type === business_sector_type
    );

    if (!matchedSheet)
        throw new Error(
            `Unknown sheet type: ${business_sector_type}`
        );

    let doc: GoogleSpreadsheet;

    // If access token is provided, use OAuth2 flow
    if (accessToken && refreshToken) {
        const oauth2Client = new OAuth2Client({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            redirectUri: `http://localhost:3000/api/auth/callback/google`,
        });

        // Set the credentials with refresh token
        oauth2Client.setCredentials({
            access_token: accessToken,
            refresh_token: refreshToken,
        });

        // Get a fresh access token
        const {token} = await oauth2Client.getAccessToken();
        if (!token) {
            throw new Error("Failed to get access token");
        }

        doc = new GoogleSpreadsheet(matchedSheet.sheetId, {
            token: token,
        });
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

    await doc.loadInfo();
    const sheet =
        doc.sheetsByTitle[business_sector_type] ??
        doc.sheetsByIndex[0];

    if (operation === "add") {
        if (!newRow)
            throw new Error("newRow is required for add operation");
        await sheet.addRow(newRow);
        return {
            success: true,
            message: "Row added successfully",
            newRow,
        };
    }

    if (operation === "update") {
        if (!rowIndex || !cellUpdates || cellUpdates.length === 0) {
            throw new Error(
                "rowIndex and non-empty cellUpdates are required for update"
            );
        }
        await sheet.loadHeaderRow();
        const headers: string[] = sheet.headerValues ?? [];
        const resolveHeader = normalizeHeaderResolver(headers);

        const rows = await sheet.getRows();
        const row = rows[rowIndex - 1];
        if (!row) throw new Error(`Row ${rowIndex} not found`);

        for (const {column, value} of cellUpdates) {
            const header = resolveHeader(column);
            if (!header) {
                throw new Error(
                    `Column "${column}" not found. Available headers: ${headers.join(
                        ", "
                    )}`
                );
            }
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
            throw new Error("rowIndex is required for delete");
        const rows = await sheet.getRows();
        const row = rows[rowIndex - 1];
        if (!row) throw new Error(`Row ${rowIndex} not found`);
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

    return {success: false, message: "Invalid operation"};
}
