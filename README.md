# 🍎 appstoreconnect-mcp

[![npm](https://img.shields.io/npm/v/@davidneyra2804/appstoreconnect-mcp.svg)](https://www.npmjs.com/package/@davidneyra2804/appstoreconnect-mcp)
[![Licencia: MIT](https://img.shields.io/badge/Licencia-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

Servidor MCP (Model Context Protocol) de **solo lectura** para la API de App Store Connect de Apple.
Transporte local por **stdio**: se conecta con **Claude Desktop**, **Cursor**, **Windsurf** o cualquier
otro cliente MCP, y contra la API solo emite peticiones `GET`.

📦 **npm**: [`@davidneyra2804/appstoreconnect-mcp`](https://www.npmjs.com/package/@davidneyra2804/appstoreconnect-mcp)
🍎 **Datos**: apps, versiones de App Store, builds de TestFlight, grupos de beta, reseñas e informes de ventas
🔑 **Credenciales**: clave de API de App Store Connect (`.p8`)
📄 **Licencia**: MIT — [LICENSE](LICENSE) y [NOTICE](NOTICE)

---

## 💡 Inicio rápido

### 1. Genera una clave de API

1. Entra en [App Store Connect](https://appstoreconnect.apple.com/) → **Usuarios y acceso** → **Integraciones** → **App Store Connect API**.
2. Crea una clave `.p8` y anota su **Key ID** y su **Issuer ID**.

### 2. Añádelo a tu cliente MCP

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

Dónde vive ese fichero: Claude Desktop `~/Library/Application Support/Claude/claude_desktop_config.json`,
Cursor `~/.cursor/mcp.json`, Windsurf `~/.codeium/windsurf/mcp_config.json`, VS Code `.vscode/mcp.json`.

> El servidor habla JSON-RPC por `stdin`/`stdout` y no muestra nada en la terminal. Es lo esperado.

Si prefieres la clave en una variable de entorno en vez de en un fichero, usa `APPLE_PRIVATE_KEY` con el
PEM en crudo o en base64.

---

## 🛠️ Herramientas

Siete, todas de lectura:

| Herramienta | Argumentos | Devuelve |
| --- | --- | --- |
| `list_apps` | — | Apps visibles en la cuenta: id, nombre, bundle id, SKU y estado |
| `get_app` | `appId` | Una app |
| `list_app_store_versions` | `appId` | Versiones de App Store, más recientes primero |
| `list_builds` | `appId` | Builds de TestFlight, más recientes primero |
| `list_beta_groups` | `appId` | Grupos de beta de TestFlight |
| `list_customer_reviews` | `appId`, `limit` (1–200, por defecto 50) | Reseñas de clientes |
| `get_sales_report` | `appId`, `date` (`YYYY-MM-DD`, por defecto ayer) | Unidades e ingresos por moneda |

---

## 💬 Ejemplos de prompts

- "Muéstrame los últimos builds de TestFlight de mi app y su estado de procesamiento."
- "¿Qué se repiten en las reseñas de 1 estrella de la última semana?"
- "Dame el informe de ventas de ayer, desglosado por moneda."
- "¿Qué versiones de App Store tiene mi app publicadas y en qué estado están?"

---

## 🔑 Variables de entorno

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `APPLE_KEY_ID` | Sí | Key ID de la clave `.p8` |
| `APPLE_ISSUER_ID` | Sí | Issuer ID (team ID) de App Store Connect |
| `APPLE_PRIVATE_KEY` | Sí\* | PEM de la clave, en crudo o en base64 |
| `APPLE_PRIVATE_KEY_PATH` | Sí\* | Ruta al fichero `.p8`, en lugar de `APPLE_PRIVATE_KEY` |
| `APPLE_APP_ID` | No | Limita el servidor a una app (id de App Store Connect) |
| `APPLE_BUNDLE_ID` | No | Limita el servidor a una app (bundle id) |
| `APPLE_APP_STORE_SKU` | No | Limita el servidor a una app (App Store ID) |
| `APPLE_VENDOR_NUMBER` | No | Número de proveedor. Necesario para `get_sales_report` |
| `LOG_LEVEL` | No | `debug`, `info` (por defecto), `warn` o `error` |

\* Configura una de las dos, no ambas.

Si defines varias variables de alcance, **todas** tienen que apuntar a la misma app: el alcance no se
amplía con una segunda variable. Detalle en [NOTES.md](NOTES.md).

---

## 💻 Desarrollo local

```bash
git clone https://github.com/davidneyra2804/appstoreconnect-mcp.git
cd appstoreconnect-mcp
npm install
npm run build
npm test
```

| Comando | Qué hace |
| --- | --- |
| `npm run build` | Compila a `dist/` |
| `npm start` | Arranca el servidor por stdio |
| `npm run dev` | Arranca en modo desarrollo (`tsx`) |
| `npm test` | Suite completa, sin red y sin credenciales reales |

---

## 🔒 Garantías

- **Solo lectura.** El inventario vive en `src/tools.ts` y la suite comprueba que el conjunto registrado coincide exactamente con esa lista y que ninguna herramienta de escritura está presente.
- **Alcance comprobado antes de la petición.** Si limitas el servidor a una app, el alcance se verifica antes de llamar a la API.
- **`stdout` es del protocolo.** Diagnósticos y trazas van a `stderr`, y los secretos se redactan antes de escribirse.

---

## 📄 Detalle

[NOTES.md](NOTES.md) recoge lo que no cabe aquí: arquitectura, contrato del informe de ventas,
publicación en npm, problemas habituales y la comparación con
[`ryaker/appstore-connect-mcp`](https://github.com/ryaker/appstore-connect-mcp), el proyecto que
inspiró el diseño.

## 🤝 Contribuir

Issues y PRs bienvenidos en [issues](https://github.com/davidneyra2804/appstoreconnect-mcp/issues).
El código llega por ramas (`feature/...`, `fix/...`) con PR a `main`.

## 📄 Licencia

MIT — [LICENSE](LICENSE). Atribución de upstream: [NOTICE](NOTICE).
