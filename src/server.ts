// server.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
    Notification,
    CallToolRequestSchema,
    ListToolsRequestSchema,
    JSONRPCError,
    InitializeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {randomUUID} from "crypto";
import {Request, Response} from "express";
import {z} from "zod";
import {GoogleSpreadsheet} from "google-spreadsheet";
import {JWT} from "google-auth-library"; // types are bundled, no @types needed
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

/** Build a registry from either GOOGLE_SHEETS_REGISTRY JSON or fallback envs */
function buildSheetsRegistry(): SheetRegistryEntry[] {
    // if (ENV.GOOGLE_SHEETS_REGISTRY) {
    //     try {
    //         const parsed = JSON.parse(
    //             ENV.GOOGLE_SHEETS_REGISTRY
    //         ) as SheetRegistryEntry[];
    //         // Validate structure and allowed types
    //         const schema = z.array(
    //             z.object({
    //                 type: z.enum([
    //                     "invoices",
    //                     "sales",
    //                     "marketing",
    //                     "clients",
    //                     "tasks",
    //                     "projects",
    //                     "employees",
    //                 ]),
    //                 sheetId: z.string().min(1),
    //                 tabTitle: z.string().optional(),
    //             })
    //         );
    //         return schema.parse(parsed);
    //     } catch (e) {
    //         throw new Error(
    //             `Invalid GOOGLE_SHEETS_REGISTRY JSON: ${
    //                 (e as Error).message
    //             }`
    //         );
    //     }
    // }

    // Fallback: build from individual env vars if present
    const fallback: Array<[SheetType, string | undefined]> = [
        ["invoices", "1nBtMw0O8I5X2DrGnWXMtP-u0wQLRRQqF_Zz_Ppe8uY4"],
        ["sales", ""],
        ["marketing", ""],
        ["clients", "1qm1qoKMvtyXoMyboSPAZmq3I9Xhw3fLiO-CijjfrE4A"],
        ["tasks", "1zzNbFSyET6EfvkSvm8jGGIQkBtVTFrotGEU4_bInpoY"],
        ["projects", "1hFjdaGlEGuyS5buCoMdKkdgoy27Ia_6txbSlsdyKbyc"],
        ["employees", "1UIIAt8IlyEP2NV8KUcubg3hlvvn3dKhcKOuWZYH7cJM"],
    ];

    return fallback
        .filter(([, id]) => Boolean(id))
        .map(([type, sheetId]) => ({
            type,
            sheetId: sheetId as string,
        }));
}

const googleSheetsRegistry: SheetRegistryEntry[] =
    buildSheetsRegistry();

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

async function openSheetByType(type: SheetType) {
    const entry = googleSheetsRegistry.find((s) => s.type === type);
    if (!entry) {
        const available = googleSheetsRegistry
            .map((s) => s.type)
            .join(", ");
        throw new Error(
            `Unknown sheet type "${type}". Available types: ${
                available || "none configured"
            }`
        );
    }

    const doc = new GoogleSpreadsheet(entry.sheetId, auth);
    await doc.loadInfo();

    // choose tab: prefer explicit tabTitle if provided, else type name, else index 0
    const title = entry.tabTitle ?? type;
    const sheet =
        (doc.sheetsByTitle && (doc.sheetsByTitle as any)[title]) ??
        doc.sheetsByTitle[type] ??
        doc.sheetsByIndex[0];

    if (!sheet)
        throw new Error(`Worksheet/tab not found for type "${type}"`);
    return {doc, sheet};
}

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
    } = ManageSheetParamsSchema.parse(params);

    const matchedSheet = googleSheets.find(
        (s) => s.type === business_sector_type
    );

    if (!matchedSheet)
        throw new Error(
            `Unknown sheet type: ${business_sector_type}`
        );

    const doc = new GoogleSpreadsheet(matchedSheet.sheetId, auth);
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
