# 🍎 appstoreconnect-mcp

[![npm](https://img.shields.io/npm/v/@davidneyra2804/appstoreconnect-mcp.svg)](https://www.npmjs.com/package/@davidneyra2804/appstoreconnect-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

A **read-only** MCP (Model Context Protocol) server for Apple's App Store Connect API.
The local **stdio** transport connects to **Claude Desktop**, **Cursor**, **Windsurf**, or any
other MCP client. The server sends only `GET` requests to the API.

📦 **npm**: [`@davidneyra2804/appstoreconnect-mcp`](https://www.npmjs.com/package/@davidneyra2804/appstoreconnect-mcp)
🍎 **Data**: apps, App Store versions, TestFlight builds, beta groups, reviews, sales reports, app information, pricing, availability, in-app purchases, and analytics
🔑 **Credentials**: App Store Connect API key (`.p8`)
📄 **License**: MIT — [LICENSE](LICENSE) and [NOTICE](NOTICE)

---

## 💡 Quick start

### 1. Generate an API key

1. Go to [App Store Connect](https://appstoreconnect.apple.com/) → **Users and Access** → **Integrations** → **App Store Connect API**.
2. Create a `.p8` key and record its **Key ID** and **Issuer ID**.

### 2. Add the server to your MCP client

```json
{
  "mcpServers": {
    "appstoreconnect": {
      "command": "npx",
      "args": ["-y", "@davidneyra2804/appstoreconnect-mcp"],
      "env": {
        "APPLE_KEY_ID": "TU_KEY_ID",
        "APPLE_ISSUER_ID": "TU_ISSUER_ID",
        "APPLE_PRIVATE_KEY_PATH": "/ruta/a/la/clave.p8"
      }
    }
  }
}
```

Configuration file locations: Claude Desktop `~/Library/Application Support/Claude/claude_desktop_config.json`,
Cursor `~/.cursor/mcp.json`, Windsurf `~/.codeium/windsurf/mcp_config.json`, VS Code `.vscode/mcp.json`.

> The server exchanges JSON-RPC messages over `stdin` and `stdout`. An idle terminal is expected.

To pass the key in an environment variable, set `APPLE_PRIVATE_KEY` to the raw PEM or its
base64-encoded value.

---

## 🛠️ Tools

All 12 tools are read-only.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_apps` | — | Apps visible to the account: ID, name, bundle ID, SKU, and status |
| `get_app` | `appId` | One app |
| `list_app_store_versions` | `appId` | App Store versions, newest first |
| `list_builds` | `appId` | TestFlight builds, newest first |
| `list_beta_groups` | `appId` | TestFlight beta groups |
| `list_customer_reviews` | `appId`, `limit` (1–200, default 50) | Customer reviews |
| `get_sales_report` | `appId`, `date` (`YYYY-MM-DD`, defaults to yesterday) | Units and proceeds by currency |
| `get_app_info_details` | `appId` | App information: status, age rating, categories, and name, subtitle, and privacy policy by language |
| `get_app_pricing` | `appId` | Pricing by territory: customer price, developer proceeds, and currency |
| `get_app_availability` | `appId` | Availability by territory: whether the app is available, release date, pre-order details, and content statuses |
| `get_in_app_purchases` | `appId` | In-app purchases: name, product ID, type, and status |
| `get_analytics` | `appId` | App analytics report requests and the reports they produced |

---

## 💬 Example prompts

- "Show me my app's latest TestFlight builds and their processing status."
- "What themes recur in last week's one-star reviews?"
- "Give me yesterday's sales report, broken down by currency."
- "Which App Store versions has my app published, and what status is each one in?"
- "In which countries is my app available, and how much does it cost in each?"
- "What in-app purchases does my app currently have, and what status is each one in?"
- "What is my app's age rating in each country?"

---

## 🔑 Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `APPLE_KEY_ID` | Yes | Key ID of the `.p8` key |
| `APPLE_ISSUER_ID` | Yes | App Store Connect Issuer ID (team ID) |
| `APPLE_PRIVATE_KEY` | Yes\* | Raw or base64-encoded PEM key |
| `APPLE_PRIVATE_KEY_PATH` | Yes\* | Path to the `.p8` file, as an alternative to `APPLE_PRIVATE_KEY` |
| `APPLE_APP_ID` | No | Restricts the server to one app (App Store Connect ID) |
| `APPLE_BUNDLE_ID` | No | Restricts the server to one app (bundle ID) |
| `APPLE_APP_STORE_SKU` | No | Restricts the server to one app (App Store ID) |
| `APPLE_VENDOR_NUMBER` | No | Vendor number. Required for `get_sales_report` |
| `LOG_LEVEL` | No | `debug`, `info` (default), `warn`, or `error` |

\* Configure exactly one of these two variables.

If you set multiple scope variables, **every variable** must identify the same app. The scope
remains limited to that app. See [NOTES.md](NOTES.md) for details.

---

## 💻 Local development

```bash
git clone https://github.com/davidneyra2804/appstoreconnect-mcp.git
cd appstoreconnect-mcp
npm install
npm run build
npm test
```

| Command | Purpose |
| --- | --- |
| `npm run build` | Compiles to `dist/` |
| `npm start` | Starts the server over stdio |
| `npm run dev` | Starts the server in development mode (`tsx`) |
| `npm test` | Runs the full suite offline without real credentials |

---

## 🔒 Guarantees

- **Read-only.** The inventory lives in `src/tools.ts`. The test suite checks that the registered tools match it exactly and that the server exposes zero write tools.
- **Scope checks precede API requests.** If you restrict the server to one app, it checks the scope before calling the API.
- **The protocol owns `stdout`.** Diagnostics and traces go to `stderr`, and the server redacts secrets before writing logs.

---

## 📄 Further details

[NOTES.md](NOTES.md) covers architecture, the sales report contract, the endpoint and limitations of
each tool, npm publishing, troubleshooting, and a comparison with
[`ryaker/appstore-connect-mcp`](https://github.com/ryaker/appstore-connect-mcp), the project that
inspired the design.

## 🤝 Contributing

Issues and pull requests are welcome. Use the [issue tracker](https://github.com/davidneyra2804/appstoreconnect-mcp/issues)
to report problems or propose changes. Submit code from a branch (`feature/...`, `fix/...`) in a pull request targeting `main`.

## 📄 License

MIT — [LICENSE](LICENSE). Upstream attribution: [NOTICE](NOTICE).
