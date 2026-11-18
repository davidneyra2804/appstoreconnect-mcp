# NOTES

Extended documentation for `appstoreconnect-mcp`. The [README](README.md) is the quick reference.
This document covers the architecture, tool contracts, publishing, and known issues.

---

## 1. What the server does

A read-only MCP server for the public App Store Connect API, using a local stdio transport.

| Included | Out of scope (later phases) |
| --- | --- |
| Local stdio transport | HTTP / OAuth transport |
| `list_apps`, `get_app` | Numerical data from an analytics report |
| `list_app_store_versions` | Write operations |
| `list_builds` (TestFlight) | |
| `list_beta_groups` (TestFlight) | |
| `list_customer_reviews` | |
| `get_sales_report` (daily report) | |
| `get_app_info_details` (app information) | |
| `get_app_pricing` (pricing by territory) | |
| `get_app_availability` (availability) | |
| `get_in_app_purchases` (in-app purchases) | |
| `get_analytics` (analytics report requests) | |

The server sends only `GET` requests. The client has no methods that send `POST`,
`PATCH`, `PUT`, or `DELETE` requests.

---

## 2. Architecture

| File | Responsibility |
| --- | --- |
| `src/tools.ts` | Tool inventory and authoritative list of what the server exposes |
| `src/config.ts` | Reads and validates environment variables, including scope settings |
| `src/appstore-client.ts` | App Store Connect client that signs ES256 JWTs and sends `GET` requests |
| `src/scope.ts` | Checks app scope before each request |
| `src/sales-report.ts` | Reads the sales report (gzip-compressed TSV) |
| `src/logger.ts` | Logs to `stderr` and redacts secrets |
| `src/server.ts` | MCP server that registers and dispatches tools |
| `src/stdio.ts` | stdio entry point that redirects `console` to `stderr` |
| `test/` | Fixture-based test suite that runs offline without real credentials |

---

## 3. Tool inventory

`src/tools.ts` defines the inventory. The test suite checks that the registered tools match the
list **exactly**. A tool name with a write verb prefix (`create`, `update`, `delete`, `submit`, …)
fails the test.

The server rejects unknown, missing, or out-of-range arguments before sending any network request.

The inventory contains **12 read-only tools**: the original seven (`list_apps`, `get_app`,
`list_app_store_versions`, `list_builds`, `list_beta_groups`, `list_customer_reviews`,
`get_sales_report`) and the five covering app information, pricing, availability, in-app purchases,
and analytics described in section 6.

`APP_SCOPED_TOOLS` lists the tools scoped to one app. It includes every tool that takes `appId`.
The suite checks that each scoped tool declares and requires `appId`. Requiring it prevents calls
to apps outside the configured scope.

---

## 4. App identifiers and scope

`APPLE_APP_ID` and `APPLE_APP_STORE_SKU` identify different fields.

| Variable | Identifier | Where to find it |
| --- | --- | --- |
| `APPLE_APP_ID` | App Store Connect app ID, the opaque `id` of the `apps` resource | Tools accept it as `appId`. `list_apps` prints it as "App id" |
| `APPLE_APP_STORE_SKU` | App Store ID, the `sku` attribute of the `apps` resource | The number displayed in App Store Connect and the App Store. `list_apps` prints it as "App Store id" |

If you set multiple scope variables, **all of them** must identify the same app. The scope remains
limited to that app.

The server rejects `APPLE_APP_STORE_ID` at startup and tells you which variable to use. The old
name was ambiguous because the documentation referred to the App Store ID while the tools identified
apps by `id`. Requiring the correct variable avoids rejecting the app you intended to allow.

---

## 5. Sales report

`get_sales_report` reads the account's daily sales report. Apple returns a **gzip-compressed TSV**
with named columns and rows in multiple currencies.

- The request uses the `SUMMARY` subtype and `DAILY` frequency. Apple returns `400` if `filter[reportSubType]` is missing.
- The vendor number comes from `APPLE_VENDOR_NUMBER`. Apple rejects the request if you supply the `issuerId` or App Store ID in its place.
- The parser looks up columns by name, with multiple accepted names for each column (`Units`/`Quantity`, `Developer Proceeds`/`Proceeds`, `SKU`/`Apple Identifier`).
- **Totals are calculated separately for each currency.** The parser rounds amounts to cents at each step to prevent binary floating-point drift.
- The date defaults to **yesterday**. Apple generates each daily report during the following day, so today's report is still unavailable.
- Apple returns `404` for both a day **with no sales** and a report it **has yet to generate**. The error details distinguish the two cases.

The account's report lists all of the vendor's apps. The tool returns only the units and proceeds
for the requested app.

`src/sales-report.ts` handles TSV parsing, gzip decompression, and column lookup. Deterministic
tests use synthetic fixtures based on Apple's column layout.

---

## 6. App information, pricing, availability, in-app purchases, and analytics

These five tools extend the read-only inventory. Each takes `appId` and checks it against the
configured scope before sending any request.

The endpoints were verified against Apple's documentation
(`developer.apple.com/documentation/appstoreconnectapi`). Upstream exposes none of the pricing,
availability, or in-app purchase endpoints, and its analytics equivalent is a write operation.

### `get_app_info_details`

| | |
| --- | --- |
| Endpoint | `GET /v1/apps/{id}/appInfos` |
| Parameters | `include=appInfoLocalizations`, `limit` |
| Scopes | The API key's existing scopes |

An app has **one app information record per App Store version**: one for the live version and one
that takes effect with the next version. The result is a list.

The tool returns the status (`appStoreState`, `state`), age rating (`appStoreAgeRating`), territory
ratings (Australia, Brazil, France, Korea), primary and secondary categories and subcategories,
and localizations (language, name, subtitle, privacy policy URL and text).

**Limitations**

- The tool requests categories inline and usually receives their names. When Apple omits the
  category from the response, the tool returns its **ID**.
- `privacyPolicyText` can be empty. Apple omits it when the policy consists only of a URL.
- `appInfoLocalizations` also has a separate endpoint (`GET /v1/apps/{id}/appInfoLocalizations`).
  The tool uses `include` to retrieve the localizations in the same request.

### `get_app_pricing`

| | |
| --- | --- |
| Endpoint | `GET /v1/apps/{id}/appPricePoints` |
| Parameters | `include=territory`, `limit`, `filter[territory]` |
| Scopes | No additional scopes |

A **price point** is the app's price in **one** territory, so the list contains one entry per
territory. Each entry includes the customer price (`customerPrice`), developer proceeds
(`proceeds`), and the territory's currency.

**Limitations**

- The price is a **string** formatted according to Apple's locale settings. The tool returns the
  string as received.
- The tool returns **gross** amounts in their original currencies. It applies no exchange rates
  and keeps each territory on a separate row, without summing amounts across currencies.
- An app that has never been offered for sale may have zero price points.
- The endpoint uses **v3** of the pricing model (`appPricePoints` / `AppPricePointV3`). Pricing
  belongs to the app. The API has no `GET /v1/appStoreVersions/{id}/appPrice` endpoint.
- The API offers `filter[territory]` and `GET /v1/apps/{id}/appPriceSchedule`. The tool omits
  both for now. A later phase can expose them if needed.

### `get_app_availability`

| | |
| --- | --- |
| Endpoint | `GET /v1/apps/{id}/appAvailabilityV2` |
| Parameters | `include=territoryAvailabilities`, `limit[territoryAvailabilities]` |
| Scopes | No additional scopes |

The tool returns the app's availability record with an inline entry for each territory. Each entry
includes whether the app is available, its release date, pre-order details (`preOrderEnabled`,
`preOrderPublishDate`), and content statuses (`contentStatuses`).

**Limitations**

- The endpoint uses **v2** (`appAvailabilityV2` / `AppAvailabilityV2`). The v1 model
  (`GET /v1/apps/{id}/appAvailability`) is deprecated.
- The API identifies each **territory by code** (`USA`, `ESP`, `JPN`, …) and omits the country
  name. To look up the name, use `GET /v1/territories` separately.
- The app can have **more than one** availability record, for example during a pre-order period.
  The tool returns a list to cover this case.

### `get_in_app_purchases`

| | |
| --- | --- |
| Endpoint | `GET /v1/apps/{id}/inAppPurchasesV2` |
| Parameters | `limit` |
| Scopes | No additional scopes |

The **v2** endpoint covers consumables, non-consumables, non-renewing subscriptions, and
**auto-renewable subscriptions**. The tool returns the name, `productId`, type
(`inAppPurchaseType`), and status (`state`).

**Limitations**

- The legacy `GET /v1/apps/{id}/inAppPurchases` endpoint omits auto-renewable subscriptions,
  so the tool uses v2.
- `productId` is the identifier used by the app code (in `SKPayment`). App Store Connect has
  a separate resource ID.
- The status applies to the **product** as a whole. Individual subscription versions have their
  own status.
- Apple supports filtering by type, name, `productId`, and status. The tool currently omits
  those filters.

### `get_analytics`

| | |
| --- | --- |
| Endpoint | `GET /v1/apps/{id}/analyticsReportRequests` |
| Parameters | `include=reports`, `limit`, `limit[reports]`, `filter[accessType]` |
| Scopes | No additional scopes |

The tool returns the account's existing **analytics report requests** for the app. Each entry
includes the access type (`accessType`: `ONE_TIME_SNAPSHOT` or `ONGOING`), whether the request
stopped due to inactivity (`stoppedDueToInactivity`), and the name and category of each report it
produced (`APP_USAGE`, `APP_STORE_ENGAGEMENT`, `COMMERCE`, `FRAMEWORK_USAGE`, `PERFORMANCE`).

**Limitations and scope for future work**

- **Creating a report request requires a write** (`POST /v1/analyticsReportRequests`). This tool
  reads existing requests only. To request a new report, use App Store Connect or a separate
  tool with write access.
- Report data (instances, segments, and CSV files) is **outside the scope** of this tool. The API
  exposes it through four endpoints:
  `GET /v1/analyticsReportRequests/{id}/reports` → `GET /v1/analyticsReports/{id}/instances` →
  `GET /v1/analyticsReportInstances/{id}/segments` → `GET /v1/analyticsReportSegments/{id}`.
  Retrieving the data requires all four calls and a tokenized URL to download the segment CSV,
  so it falls outside the read-only scope of this phase.
- The request response contains the app's report **catalog**. The report figures are available
  through the separate endpoints above.

### Common errors for these five tools

| Symptom | Cause | Solution |
| --- | --- | --- |
| `403` when requesting pricing, availability, or in-app purchases | The API key lacks permission to access those resources | Check the key's roles in App Store Connect → Integrations. A read-only role without App Store Connect access returns `403` |
| `404` from `appInfos` | The app has never been on the App Store | An app needs a published version to have an app information record |
| `404` from `appPricePoints` | The app has never been offered for sale or has no price in that territory | Each territory has its own price point. A territory without a price has no entry |
| Empty availability list | The app has no availability record | Check that the app is published in at least one territory |
| `get_analytics` returns nothing | The account has created no report requests for that app | Create the requests in App Store Connect |
| `appAvailabilityV2` returns multiple records | The app has more than one availability record (pre-order and sale) | The tool shows every record |


---

## 7. stdio transport

`stdout` carries only the MCP protocol's JSON-RPC frames. All diagnostics, warnings,
and traces go to `stderr`.

The entry point redirects `console` to `stderr` before importing other modules. This prevents
dependencies that log during import from corrupting the protocol stream.

If required configuration is missing, the server writes the error to `stderr`, leaves
`stdout` empty, and exits with a nonzero status.

---

## 8. Log security

- All diagnostics go to `stderr`. `stdout` carries only JSON-RPC.
- The logger redacts secret values before writing. It replaces values under secret field names (`privateKey`, `authorization`, `token`, …) with a non-reversible fingerprint.
- The logger also redacts secrets embedded in free-form text, including PEM blocks, `Bearer` tokens, and `clave: valor` pairs.
- The logger truncates long strings.

---

## 9. Comparison with `ryaker/appstore-connect-mcp`

[ryaker/appstore-connect-mcp](https://github.com/ryaker/appstore-connect-mcp) (MIT) remains the
reference project in this domain. This repository is a separate implementation with its own scope.

| | upstream | this repository |
| --- | --- | --- |
| Tools | 15, including write tools | 12, all read-only |
| Transport | HTTP, stdio, and SSE, with OAuth2/Auth0 | Local stdio |
| Packaging | npm, Docker, Vercel, Smithery, MCP Registry | npm |
| Authentication | API key or OAuth2/Auth0 | API key (`.p8`) |
| Tests | Scripts that call the live API | Offline fixture-based suite in CI |

What this repository improves:

- **Read-only by design.** The inventory lives in `src/tools.ts`. The test suite checks that the registered tools match it exactly and that the server exposes zero write tools.
- **The server checks app scope before every request.**
- **`stdout` is reserved for protocol messages.** Diagnostics and traces go to `stderr`, and the logger redacts secrets before writing.
- **The server parses the Apple sales report directly.** It reads a gzip-compressed TSV of subtype `SUMMARY`, reports proceeds per currency, and keeps totals for each currency separate. The equivalent upstream tool remains broken on `main`. Upstream PR #5 fixes it and was still open when checked on 2026-11-17.
- **This repository adds five read-only tools for app information, pricing, availability, in-app purchases, and analytics.** Upstream lacks the pricing, availability, and in-app purchase operations. Its analytics tool (`createAnalyticsReportRequest`) performs a **write** by sending a `POST` to `/analyticsReportRequests`. This server reads the information with `GET /v1/apps/{id}/analyticsReportRequests`. Apple's documentation was used to verify the other endpoints.

A possible future addition from upstream is an HTTP transport that binds to `127.0.0.1` by default
(PR #6, also open). Section 13 specifies the requirement.

---

## 10. npm publishing

The package is published to the public npm registry as
`@davidneyra2804/appstoreconnect-mcp`.

`.github/workflows/publish.yml` runs when a release is published or when manually triggered with
`workflow_dispatch`. Authentication uses OIDC. npm exchanges the runner's identity for a
short-lived publishing token, so the repository stores no npm secret.

Publishing generates a provenance artifact (`--provenance`). npm cryptographically attests that
the tarball came from this repository and workflow. The publish command sets the flag directly
because npm only generates provenance in GitHub Actions or GitLab CI. Setting the flag in
`publishConfig` would cause a manual publish from a laptop to fail.

### Trusted publishing: npm setup

Configure trusted publishing **on the published package's page**:

1. Sign in to [npmjs.com](https://www.npmjs.com) with the publishing account.
2. Go to **Packages** → `@davidneyra2804/appstoreconnect-mcp` → **Settings**.
3. Under **Trusted publishing**, enable a *trusted publisher* for GitHub Actions.
4. Enter:
   - **Organization or user account**: `davidneyra2804`
   - **Repository**: `appstoreconnect-mcp`
   - **Workflow filename**: `publish.yml` (the filename only, without the `.github/workflows/` path)
5. Save.

Check the following during setup:

- **Publishing permissions.** Configurations created on or after 2026-09-03 allow only `npm stage publish` by default. Explicitly enable `npm publish` for this workflow to work as written.
- **Expiration.** The configuration **expires** if its first publish does not complete within two days of setup.
- **Token access.** After setting up and testing the *trusted publisher*, you can disable token-based publishing under **Settings → Publishing access**. OIDC then becomes the only publishing method, eliminating the need for a long-lived token that could leak.
- **Publish the first version manually.** npm requires the package to exist in the registry before you can configure a *trusted publisher*.

### Publish a version

```bash
npm version patch        # actualiza package.json y package-lock.json
npm ci
npm run build
npm test
npm pack --dry-run       # comprueba qué entra en la tarball

git tag v0.1.3 && git push origin v0.1.3
```

Publishing the GitHub release triggers `.github/workflows/publish.yml`, which builds the package,
checks the types, runs the tests, verifies the tarball, and publishes it.

The workflow publishes the version in `package.json` and fails if it differs from the release
tag. Published versions are immutable, so corrections require a new version.

At runtime the server reads `package.json` for the version it announces in the MCP handshake.
Clients therefore see the installed package version, without relying on a hard-coded constant
that can go stale.

### The `0.0.0-stage` version in the registry

The registry also lists `0.0.0-stage`, a two-file placeholder (about 357 bytes) left over from
testing npm's *staging* workflow. It appears in the version list outside `latest` and has no
effect on installation or `npx`.

Only the package owner can reject it:

```bash
npm stage list                       # ver el stage pendiente
npm stage reject <stage-id>          # quitarlo del registro
```

Rejection is optional and up to the maintainer.

### Alternative: `npm stage publish`

npm recommends a Trusted Publishing variant in which CI **only** packages the version and
uploads it to *staging*. The owner then approves it on the website using 2FA. In this variant:

- npm allows only `npm stage publish` and disables `npm publish`.
- The workflow runs `npm stage publish` in place of `npm publish`.
- The version remains pending on npmjs.com until the owner approves it.

Explicit human approval is required for a version to reach `latest`. This adds one manual step
per version, and npm *staging* lacks the SLA and metrics of the regular registry.

This package has one maintainer and releases infrequently. The recommended option is **Trusted
Publishing with `npm publish` and approval through a GitHub release**. The release tag explicitly
authorizes publishing, which keeps the workflow short.

---

## 11. Troubleshooting

### Installation

| Symptom | Cause | Solution |
| --- | --- | --- |
| `npm error engine Unsupported engine` | Node earlier than 18 | Install Node 18 or later. The package is ESM-only and uses `type: module` |
| `npm error cannot find module .../dist/stdio.js` at startup | A tarball was packed without a build | Published versions run `prepack` to build before packaging. This symptom indicates a manually created local tarball |
| `EACCES` writing to the npm cache (`.../_cacache/tmp`) when starting with `npx` | The user running the MCP client cannot write to the configured npm cache on that host | Add `npm_config_cache` to that server's `env` block and set it to a path the client user can create and write to. This fixes permissions for installation on the host and leaves App Store Connect credentials and permissions intact |
| `command not found: appstoreconnect-mcp` after `npm install --global` | The global npm directory is missing from `PATH` | Check `npm bin -g` (or `npm prefix -g`) and add the directory to `PATH` |
| `npx` appears to hang | The server is waiting for input on `stdin` | The server is waiting for JSON-RPC frames as expected. Press Ctrl+C to exit |

### Authentication

| Symptom | Cause | Solution |
| --- | --- | --- |
| `Configuration error {message=Missing required environment variable(s): APPLE_KEY_ID, APPLE_ISSUER_ID, APPLE_PRIVATE_KEY or APPLE_PRIVATE_KEY_PATH.}` on `stderr`, with an empty `stdout` | Required settings are missing | Set `APPLE_KEY_ID`, `APPLE_ISSUER_ID` and the private key: `APPLE_PRIVATE_KEY` (recommended) or `APPLE_PRIVATE_KEY_PATH`. The error goes to `stderr` and `stdout` stays empty by design |
| `401` or `403` when calling the API | The `.p8` key does not match the `issuerId`, or the key has been revoked | Verify that the key and `issuerId` belong to the same App Store Connect team |
| `403` from `GET /v1/apps` | The API key lacks permission to access the resources | Regenerate the key in App Store Connect → Integrations |
| Passing the key through an environment variable instead of a file | `APPLE_PRIVATE_KEY` contains the PEM text of the `.p8` key: real line breaks, `\n` escapes or base64 | All three forms work. Inline `APPLE_PRIVATE_KEY` is the recommended one, because a client that runs in another environment cannot read a path on your disk. Use `APPLE_PRIVATE_KEY_PATH` only when the client runs on the same machine as the file |
| The server cannot see the variables | The MCP client passes variables through its own `env` block | Check the `env` block in the client configuration. The child process inherits only the settings declared there |

### Publishing

| Symptom | Cause | Solution |
| --- | --- | --- |
| `npm error This command requires you to be logged in` | The repository and workflow lack a configured *trusted publisher*, or the workflow lacks `id-token: write` | Configure it in npmjs.com → Packages → Settings → Trusted publishing, with the workflow name `publish.yml` |
| `npm error 402 Payment required` / `EOTP` | The registry already contains the version | Bump the version. Published versions are immutable |
| `npm error Invalid package name` or `cannot publish over` | The version in `package.json` differs from the tag, or the version has already been published | Check the tag and the `package.json` version |
| `npm warn No bin file found at dist/stdio.js` | The tarball was packed without a build | `prepack` builds before packaging. This message means the build failed. Check the build step |
| `npm error unsupported engine` | Node earlier than 18 | Use Node 18 or later |

npm requires CLI 11.5.1 or later and Node 22.14 or later for OIDC. Configure *trusted publishing*
on the page of an existing package. Provenance (`--provenance`) is generated only in GitHub Actions
or GitLab CI.

---

## 12. Development, testing, and CI

```bash
npm run build                 # compilar a dist/
npm test                      # suite completa (mocks y fixtures, sin red)
npx tsc -p tsconfig.test.json # comprobación de tipos de src/ y test/
```

The test suite uses fixtures and an ES256 key generated in memory. It uses no real Apple credentials.

`.github/workflows/ci.yml` runs `npm ci`, `npm run build`, `npx tsc -p tsconfig.test.json`, and
`npm test` on every push to `main` and every pull request, with a Node 18 and 20 matrix. The workflow
also checks the repository for organization names.

---

## 13. HTTP transport (later phase)

HTTP transport is **planned**. Its implementation must meet these requirements:

- **Bind to `127.0.0.1` by default.** Document `HOST` as the explicit override. Never default to `0.0.0.0`.
- **Require OAuth before exposing the server.** Upstream accepts unauthenticated requests when `OAUTH_ENABLED` is unset. This server must require authentication before it is exposed over HTTP.

Reference: upstream PR #6.
