# appstoreconnect-mcp

Servidor MCP (Model Context Protocol) de **solo lectura** para la API de App Store Connect
de Apple. Transporte local **stdio**.

Proyecto personal de **David Neyra**.

## Estado

MVP. La superficie expuesta es de lectura únicamente: el servidor no registra, y no
permite registrar, ninguna herramienta de escritura.

Este repositorio recibe el código por ramas (`feature/...`, `fix/...`) con PR a `main`.

- Superficie actual: 6 herramientas de lectura sobre apps, versiones de App Store,
  builds de TestFlight, grupos de beta y reseñas de clientes.
- Todavía fuera de alcance: informes de ventas, métricas de analytics, transporte HTTP
  con OAuth y cualquier operación de escritura.

## Alcance de esta fase

| Incluido | Excluido (fases posteriores) |
| --- | --- |
| Transporte stdio local | Transporte HTTP / OAuth (referencia: upstream PR #6) |
| `list_apps`, `get_app` | Informes de ventas (`get_sales_data`, referencia: upstream PR #5) |
| `list_app_store_versions` | Métricas de analytics |
| `list_builds` (TestFlight) | Operaciones de escritura |
| `list_beta_groups` (TestFlight) | |
| `list_customer_reviews` | |

El servidor solo emite peticiones `GET` contra la API de App Store Connect. El cliente
no contiene ningún método que haga `POST`, `PATCH`, `PUT` o `DELETE`.

## Comparación con `ryaker/appstore-connect-mcp`

Este repositorio **no** es una copia ni un superconjunto de
[ryaker/appstore-connect-mcp](https://github.com/ryaker/appstore-connect-mcp) (MIT, 60
estrellas, 12 forks), que sigue siendo la referencia del dominio. Comparación verificada:

| | upstream | este repositorio |
| --- | --- | --- |
| Herramientas | 15, de las cuales 3 de escritura | 6, todas de lectura |
| Transporte | HTTP, stdio y SSE, con OAuth2/Auth0 | stdio local |
| Empaquetado | npm `@ryaker/appstore-connect-mcp`, Docker, Vercel, Smithery, MCP Registry | npm `@davidneyra2804/appstoreconnect-mcp`, sin publicar |
| Autenticación | clave de API o OAuth2/Auth0 | clave de API (`.p8`) |
| Pruebas | scripts contra la API real | suite con fixtures, sin red |

Lo que este repositorio hace mejor:

- **La escritura no existe por construcción.** El inventario vive en `src/tools.ts` y la
  suite comprueba que el conjunto registrado coincide exactamente con esa lista y que
  ninguna herramienta de escritura está presente.
- **El alcance por app se comprueba antes de cualquier petición**, no después.
- **`stdout` queda reservado al protocolo**; diagnósticos y trazas van a `stderr`, y los
  secretos se redactan antes de escribirse.

Pendiente de adoptar de upstream, con sus PR de referencia: informes de ventas (PR #5) y
transporte HTTP con el servidor atado a `127.0.0.1` por defecto (PR #6).

## Requisitos

- Node.js >= 18
- Una clave de API de App Store Connect (`.p8`) y su `issuerId`

## Instalación

```bash
npm install
npm run build
```

## Configuración

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `APPLE_KEY_ID` | Sí | Key ID de la clave `.p8` |
| `APPLE_ISSUER_ID` | Sí | Issuer ID (team ID) de App Store Connect |
| `APPLE_PRIVATE_KEY` | Sí\* | Contenido PEM de la clave `.p8` (raw o base64) |
| `APPLE_PRIVATE_KEY_PATH` | Sí\* | Ruta al archivo `.p8`, en lugar de `APPLE_PRIVATE_KEY` |
| `APPLE_BUNDLE_ID` | No | Restringe el servidor a una app por bundle id |
| `APPLE_APP_ID` | No | Restringe el servidor a una app por su App Store Connect app id (el `id` del recurso `apps`) |
| `APPLE_APP_STORE_SKU` | No | Restringe el servidor a una app por su App Store ID (el atributo `sku` del recurso `apps`) |
| `LOG_LEVEL` | No | `debug`, `info`, `warn` o `error`. Por defecto `info` |

\* Configure una de las dos, no ambas.

Las credenciales se dan por variables de entorno o gestor de secretos: nunca se versionan
en este repositorio.

### Restricción de alcance

Si define `APPLE_BUNDLE_ID`, `APPLE_APP_ID` o `APPLE_APP_STORE_SKU`, el servidor comprueba el
alcance de cada app antes de cualquier petición. Una app fuera del alcance se rechaza con un error
y no se emite ninguna llamada a la API para ese recurso.

Los dos identificadores de app son distintos y no intercambiables:

| Variable | Identificador | Dónde se ve |
| --- | --- | --- |
| `APPLE_APP_ID` | App Store Connect app id, el `id` opaco del recurso `apps` | Es el valor que las tools aceptan como `appId`. `list_apps` lo imprime como "App id" |
| `APPLE_APP_STORE_SKU` | App Store ID, el atributo `sku` del recurso `apps` | El número que ve el usuario en App Store Connect y en la App Store. `list_apps` lo imprime como "App Store id" |

Si define más de una, **todas** tienen que coincidir: el alcance no se puede ampliar definiendo una
segunda variable.

`APPLE_APP_STORE_ID` ya no se acepta. Era ambiguo (se documentaba como App Store ID pero las tools
identifican la app por su `id`) y el servidor lo rechaza al arrancar con un mensaje que indica la
variable correcta, en lugar de interpretar el valor de una forma que pudiera denegar la app
permitida.

## Uso

Como servidor stdio local:

```bash
node dist/stdio.js
```

Configuración de cliente MCP:

```json
{
  "mcpServers": {
    "appstoreconnect": {
      "command": "npx",
      "args": ["-y", "@davidneyra2804/appstoreconnect-mcp"],
      "env": {
        "APPLE_KEY_ID": "...",
        "APPLE_ISSUER_ID": "...",
        "APPLE_PRIVATE_KEY_PATH": "/ruta/a/la/clave.p8"
      }
    }
  }
}
```

## Transporte stdio

`stdout` transporta exclusivamente tramas JSON-RPC del protocolo MCP. Todos los
diagnósticos, avisos y trazas van a `stderr`.

La redirección de `console` a `stderr` se instala antes de importar cualquier otro
módulo, de modo que una dependencia que registre al importarse no puede corromper el
flujo del protocolo.

Si falta la configuración obligatoria, el servidor escribe el error en `stderr`, deja
`stdout` vacío y termina con código distinto de cero.

## Herramientas

Todas las herramientas son de lectura.

| Herramienta | Argumentos | Devuelve |
| --- | --- | --- |
| `list_apps` | — | Apps visibles en la cuenta |
| `get_app` | `appId` | Una app |
| `list_app_store_versions` | `appId` | Versiones de App Store, más recientes primero |
| `list_builds` | `appId` | Builds de TestFlight, más recientes primero |
| `list_beta_groups` | `appId` | Grupos de beta de TestFlight |
| `list_customer_reviews` | `appId`, `limit` (opcional, 1–200, por defecto 50) | Reseñas de clientes |

Un argumento desconocido o fuera de rango se rechaza antes de emitir cualquier
petición de red.

## Seguridad de los logs

- Todos los diagnósticos van a `stderr`; `stdout` nunca lleva texto que no sea
  JSON-RPC.
- Los valores secretos se redactan antes de escribir: claves con nombre de secreto
  (`privateKey`, `authorization`, `token`, ...) se sustituyen por una huella no
  reversible.
- El material secreto incrustado en texto libre también se redacta: bloques PEM,
  tokens `Bearer` y pares `clave: valor`.
- Las cadenas largas se truncan.

## Desarrollo

```bash
npm run build          # compilar a dist/
npm test               # suite completa (mocks y fixtures, sin red)
npx tsc -p tsconfig.test.json   # comprobación de tipos de src/ y test/
```

La suite usa fixtures y una clave ES256 generada en memoria. No se usa ninguna credencial
real de Apple.

## Licencia

MIT. Ver [LICENSE](LICENSE).

Atribución de upstream y relación con `ryaker/appstore-connect-mcp`: ver [NOTICE](NOTICE).
