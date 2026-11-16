# appstoreconnect-mcp

Servidor MCP (Model Context Protocol) de **solo lectura** para la API de App Store Connect
de Apple. Transporte local **stdio**.

Proyecto personal de **David Neyra**.

## Estado

MVP. La superficie expuesta es de lectura únicamente: el servidor no registra, y no
permite registrar, ninguna herramienta de escritura.

Este repositorio recibe el código por ramas (`feature/...`, `fix/...`) con PR a `main`.

- Superficie actual: 7 herramientas de lectura sobre apps, versiones de App Store,
  builds de TestFlight, grupos de beta, reseñas de clientes e informes de ventas.
- Todavía fuera de alcance: métricas de analytics, transporte HTTP con OAuth y
  cualquier operación de escritura.

## Alcance de esta fase

| Incluido | Excluido (fases posteriores) |
| --- | --- |
| Transporte stdio local | Transporte HTTP / OAuth (referencia: upstream PR #6) |
| `list_apps`, `get_app` | Métricas de analytics |
| `list_app_store_versions` | Operaciones de escritura |
| `list_builds` (TestFlight) | |
| `list_beta_groups` (TestFlight) | |
| `list_customer_reviews` | |
| `get_sales_report` (informe diario de ventas) | |

El servidor solo emite peticiones `GET` contra la API de App Store Connect. El cliente
no contiene ningún método que haga `POST`, `PATCH`, `PUT` o `DELETE`.

## Comparación con `ryaker/appstore-connect-mcp`

Este repositorio **no** es una copia ni un superconjunto de
[ryaker/appstore-connect-mcp](https://github.com/ryaker/appstore-connect-mcp) (MIT, 60
estrellas, 12 forks), que sigue siendo la referencia del dominio. Comparación verificada:

| | upstream | este repositorio |
| --- | --- | --- |
| Herramientas | 15, de las cuales 3 de escritura | 7, todas de lectura |
| Transporte | HTTP, stdio y SSE, con OAuth2/Auth0 | stdio local |
| Empaquetado | npm `@ryaker/appstore-connect-mcp`, Docker, Vercel, Smithery, MCP Registry | npm `@davidneyra2804/appstoreconnect-mcp` |
| Autenticación | clave de API o OAuth2/Auth0 | clave de API (`.p8`) |
| Pruebas | scripts contra la API real | suite con fixtures, sin red, en CI |

Lo que este repositorio hace mejor:

- **La escritura no existe por construcción.** El inventario vive en `src/tools.ts` y la
  suite comprueba que el conjunto registrado coincide exactamente con esa lista y que
  ninguna herramienta de escritura está presente.
- **El alcance por app se comprueba antes de cualquier petición**, no después.
- **`stdout` queda reservado al protocolo**; diagnósticos y trazas van a `stderr`, y los
  secretos se redactan antes de escribirse.
- **El informe de ventas se lee como el informe que es**: TSV comprimido por gzip, con
  subtipo `SUMMARY`, proceeds por moneda y sin sumar nunca importes de monedas distintas.
  Upstream mantiene su equivalente roto en `main`; su PR #5 lo corrige.

Pendiente de adoptar de upstream: el transporte HTTP con el servidor atado a `127.0.0.1`
por defecto (PR #6). El requisito queda escrito en [Transporte HTTP](#transporte-http-fase-posterior).

## Requisitos

- Node.js >= 18
- Una clave de API de App Store Connect (`.p8`) y su `issuerId`
- Para el informe de ventas, el número de proveedor (`APPLE_VENDOR_NUMBER`)

## Instalación

Desde npm, una vez publicado:

```bash
npm install --global @davidneyra2804/appstoreconnect-mcp
```

O sin instalar nada, con `npx`:

```bash
npx -y @davidneyra2804/appstoreconnect-mcp
```

Desde el código:

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
| `APPLE_VENDOR_NUMBER` | No | Número de proveedor de la cuenta. Necesario para `get_sales_report` |
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
| `get_sales_report` | `appId`, `date` (opcional, `YYYY-MM-DD`, por defecto ayer) | Unidades y proceeds por moneda del informe diario de ventas |

Un argumento desconocido, ausente o fuera de rango se rechaza antes de emitir cualquier
petición de red.

## Informe de ventas

`get_sales_report` lee el informe diario de ventas de la cuenta. El informe de Apple no es
JSON: es un **TSV comprimido con gzip**, con las columnas nombradas y con filas de varias
monedas mezcladas.

- Se pide el subtipo `SUMMARY` y la frecuencia `DAILY`. Sin `filter[reportSubType]` Apple
  responde `400`.
- El número de proveedor se toma de `APPLE_VENDOR_NUMBER`. No es el `issuerId` ni el App
  Store ID: Apple rechaza la petición con el valor equivocado.
- Las columnas se leen por nombre, no por posición, y cada columna admite varias
  grafías (`Units`/`Quantity`, `Developer Proceeds`/`Proceeds`, `SKU`/`Apple Identifier`).
- **Los importes nunca se suman entre monedas.** Cada moneda tiene su propia cifra, y los
  importes se redondean a céntimos en cada paso, para que la aritmética binaria no desplace
  el resultado.
- La fecha por defecto es **ayer**: Apple genera el informe diario durante el día
  siguiente, así que el informe de hoy todavía no existe.
- Se distinguen dos casos que Apple responde igual con un `404`: un día **sin ventas** y un
  informe **aún no generado**. Solo el detalle del error los separa.

El informe pertenece a la cuenta, no a una app: lista todas las apps del proveedor. La
herramienta es de alcance por app, así que solo devuelve las unidades y los proceeds de la
app solicitada y nunca los de otra.

El análisis de TSV, gzip y multicolumna vive en `src/sales-report.ts` y está cubierto por
pruebas deterministas: fixtures sintéticos con el layout de columnas de Apple, sin red y
sin credenciales reales.

## Transporte HTTP (fase posterior)

El transporte HTTP **no está implementado**. Cuando se aborde, quedan fijados estos
requisitos:

- **Escucha en `127.0.0.1` por defecto**, nunca en `0.0.0.0`. `HOST` documentado para
  cambiarlo de forma explícita.
- **OAuth es condición para exponerlo.** Un servidor HTTP sin autenticación no se
  publica: upstream acepta peticiones sin autenticar cuando `OAUTH_ENABLED` no está
  definido, y ese hueco no se reproduce aquí.

Referencia: upstream PR #6.

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

## CI

`.github/workflows/ci.yml` ejecuta `npm ci`, `npm run build`, `npx tsc -p tsconfig.test.json`
y `npm test` en cada push a `main` y en cada pull request, con la matriz de Node 18 y 20.
El pipeline también comprueba que el repositorio no menciona a ninguna organización.

## Publicación

El paquete se publica en el registro público de npm como
`@davidneyra2804/appstoreconnect-mcp`.

`.github/workflows/publish.yml` publica cuando se publica una release (o a mano,
con `workflow_dispatch`). La autenticación usa OIDC: npm cambia la identidad del
runner por un token de publicación de corta duración, así que el repositorio no
guarda ningún secreto de npm. npm exige la CLI 11.5.1 o posterior y Node 22.14 o
posterior, y el workflow instala la última versión de npm antes de publicar.

La publicación genera un artefacto de procedencia (`--provenance`): npm firma de
forma criptográfica que el tarball salió de este repositorio y de este workflow.

La primera versión hay que publicarla a mano, con `npm login` y `npm publish
--access public`, porque un *trusted publisher* solo se puede configurar en npm
una vez que el paquete ya existe. A partir de ahí, las siguientes versiones salen
solas desde la release.

El número de versión de `package.json` es el que se publica; conviene que coincida
con la tag de la release.

## Licencia

MIT. Ver [LICENSE](LICENSE).

Atribución de upstream y relación con `ryaker/appstore-connect-mcp`: ver [NOTICE](NOTICE).
