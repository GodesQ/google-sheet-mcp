# Google Sheets MCP Server

A Model Context Protocol (MCP) server that provides tools for managing Google Sheets data. This server allows you to create, read, update, and delete data in Google Sheets for various business sectors like invoices, tasks, employees, clients, sales, projects, and marketing.

## Features

- **CRUD Operations**: Add, read, update, and delete rows in Google Sheets
- **Multiple Business Sectors**: Support for invoices, sales, marketing, clients, tasks, projects, and employees
- **Filtering & Pagination**: Advanced querying capabilities with filters, limits, and offsets
- **Session Management**: Maintains MCP sessions for persistent connections
- **CORS Support**: Cross-origin resource sharing enabled for web clients

## Prerequisites

Before deploying, you need:

1. **Google Service Account**: A Google Cloud service account with Google Sheets API access
2. **Google Sheets**: Pre-configured Google Sheets with the appropriate structure
3. **Vercel Account**: For deployment (free tier available)

## Environment Variables

You need to set up the following environment variables in Vercel:

### Required Variables

```bash
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour Private Key Here\n-----END PRIVATE KEY-----"
```

### Optional Variables (for specific sheet IDs)

```bash
SHEET_ID_INVOICES=your-invoices-sheet-id
SHEET_ID_SALES=your-sales-sheet-id
SHEET_ID_MARKETING=your-marketing-sheet-id
SHEET_ID_CLIENTS=your-clients-sheet-id
SHEET_ID_TASKS=your-tasks-sheet-id
SHEET_ID_PROJECTS=your-projects-sheet-id
SHEET_ID_EMPLOYEES=your-employees-sheet-id
```

## Deployment Steps

### 1. Prepare Your Google Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Google Sheets API
4. Create a Service Account:
   - Go to "IAM & Admin" > "Service Accounts"
   - Click "Create Service Account"
   - Give it a name and description
   - Grant "Editor" role
5. Create and download a JSON key file
6. Extract the `client_email` and `private_key` from the JSON file

### 2. Set Up Google Sheets

1. Create Google Sheets for each business sector you want to manage
2. Share each sheet with your service account email (with Editor permissions)
3. Note down the Sheet IDs from the URLs (the long string between `/d/` and `/edit`)

### 3. Deploy to Vercel

#### Option A: Using Vercel CLI

1. Install Vercel CLI:
   ```bash
   npm i -g vercel
   ```

2. Login to Vercel:
   ```bash
   vercel login
   ```

3. Deploy the project:
   ```bash
   vercel
   ```

4. Set environment variables:
   ```bash
   vercel env add GOOGLE_SERVICE_ACCOUNT_EMAIL
   vercel env add GOOGLE_PRIVATE_KEY
   ```

#### Option B: Using Vercel Dashboard

1. Push your code to GitHub/GitLab/Bitbucket
2. Go to [Vercel Dashboard](https://vercel.com/dashboard)
3. Click "New Project"
4. Import your repository
5. Configure environment variables in the project settings
6. Deploy

### 4. Configure Environment Variables in Vercel

1. Go to your Vercel project dashboard
2. Navigate to "Settings" > "Environment Variables"
3. Add the following variables:

   **GOOGLE_SERVICE_ACCOUNT_EMAIL**
   - Value: Your service account email
   - Environment: Production, Preview, Development

   **GOOGLE_PRIVATE_KEY**
   - Value: Your private key (include the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` parts)
   - Environment: Production, Preview, Development

4. Redeploy your application

## MCP Server URL Structure

Once deployed, your MCP server will be available at:

### Base URL
```
https://your-project-name.vercel.app
```

### MCP Endpoints

- **Main MCP Endpoint**: `https://your-project-name.vercel.app/mcp`
- **Health Check**: `https://your-project-name.vercel.app/`

### Using with MCP Clients

When configuring your MCP client, use the following URL:

```
https://your-project-name.vercel.app/mcp
```

## Available Tools

The server provides one main tool: `manage-sheet`

### Tool Parameters

- **business_sector_type**: `"invoices" | "sales" | "marketing" | "clients" | "tasks" | "projects" | "employees"`
- **operation**: `"add" | "update" | "delete" | "read"`

### Example Operations

#### Read Data
```json
{
  "business_sector_type": "invoices",
  "operation": "read",
  "limit": 10,
  "offset": 0
}
```

#### Add Row
```json
{
  "business_sector_type": "invoices",
  "operation": "add",
  "newRow": {
    "Invoice Number": "INV-001",
    "Client": "John Doe",
    "Amount": "1000.00",
    "Status": "Pending"
  }
}
```

#### Update Row
```json
{
  "business_sector_type": "invoices",
  "operation": "update",
  "rowIndex": 2,
  "cellUpdates": [
    {"column": "Status", "value": "Paid"},
    {"column": "Amount", "value": "1200.00"}
  ]
}
```

#### Delete Row
```json
{
  "business_sector_type": "invoices",
  "operation": "delete",
  "rowIndex": 3
}
```

## Testing the Deployment

1. **Health Check**: Visit `https://your-project-name.vercel.app/` to verify the server is running
2. **MCP Connection**: Use an MCP client to connect to `https://your-project-name.vercel.app/mcp`

## Troubleshooting

### Common Issues

1. **Environment Variables Not Set**: Ensure all required environment variables are configured in Vercel
2. **Google Sheets Permissions**: Make sure your service account has access to the Google Sheets
3. **Private Key Format**: Ensure the private key includes the full PEM format with headers
4. **CORS Issues**: The server is configured to allow all origins (`*`) - adjust if needed for production

### Debugging

- Check Vercel function logs in the dashboard
- Verify environment variables are correctly set
- Test Google Sheets API access locally first

## Local Development

To run the server locally:

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file with your environment variables

3. Build and run:
   ```bash
   npm run dev
   ```

4. The server will be available at `http://localhost:8123`

## Security Considerations

- **CORS**: Currently set to allow all origins - consider restricting for production
- **Authentication**: The server uses Google Service Account authentication
- **Rate Limiting**: Consider implementing rate limiting for production use
- **Environment Variables**: Never commit sensitive credentials to version control

## Support

For issues and questions:
1. Check the Vercel function logs
2. Verify Google Sheets API setup
3. Test with a simple MCP client first

## License

ISC License
