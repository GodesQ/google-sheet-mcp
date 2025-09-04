import dotenv from "dotenv";
import process from "node:process";

// Build output is ESM. Ensure you've run `npm run build` before this test.
import {fetchGoogleSheetsDataSource} from "./build/server.js";

dotenv.config();

function parseArg(name, fallback) {
    const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (arg) return arg.split("=")[1];
    return process.env[name.toUpperCase()] || fallback;
}

async function main() {
    const defaultTenant = "01990359-fe4c-731d-800b-b61d36f29809";
    const tenantId = parseArg("tenant", defaultTenant);

    const appAuthToken = parseArg(
        "token",
        "12|GzryFEnhHfGDvsKabW1RBHpg4MZhBwO51j2DCJQB45239457"
    );
    if (!appAuthToken) {
        console.error(
            "❌ Missing app auth token. Provide via --token=<JWT> or APP_AUTH_TOKEN env."
        );
        process.exit(1);
    }

    const baseUrl =
        process.env.DATA_SOURCES_API_BASE_URL ||
        process.env.BACKEND_URL ||
        "http://127.0.0.1:8000";
    console.log("🔧 Using base URL:", baseUrl);
    console.log("🏷️ Tenant ID:", tenantId);

    try {
        const result = await fetchGoogleSheetsDataSource(
            appAuthToken,
            tenantId
        );
        console.log("\n🧪 fetchGoogleSheetsDataSource result:");
        console.log(JSON.stringify(result, null, 2));

        if (result.status === "failed") {
            console.error("\n❌ Test FAILED");
            process.exit(2);
        }

        console.log("\n✅ Test PASSED");
    } catch (err) {
        console.error(
            "\n❌ Exception during test:",
            err?.message || err
        );
        if (err?.stack) console.error(err.stack);
        process.exit(3);
    }
}

main();
