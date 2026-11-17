# NOTES

Documentación extendida de `appstoreconnect-mcp`. El [README](README.md) es la referencia rápida;
aquí queda el detalle: arquitectura, contratos, publicación y problemas conocidos.

---

## 1. Qué es y qué no es

Un servidor MCP de solo lectura sobre la API pública de App Store Connect, con transporte local
por stdio.

| Incluido | Fuera de alcance (fases posteriores) |
| --- | --- |
| Transporte stdio local | Transporte HTTP / OAuth |
| `list_apps`, `get_app` | Métricas de analytics |
| `list_app_store_versions` | Operaciones de escritura |
| `list_builds` (TestFlight) | |
| `list_beta_groups` (TestFlight) | |
| `list_customer_reviews` | |
| `get_sales_report` (informe diario) | |

El servidor solo emite peticiones `GET`. El cliente no contiene ningún método que haga `POST`,
`PATCH`, `PUT` o `DELETE`.

---

## 2. Arquitectura

| Fichero | Responsabilidad |
| --- | --- |
| `src/tools.ts` | Inventario de herramientas. Única fuente de verdad de lo que el servidor expone |
| `src/config.ts` | Lectura y validación de variables de entorno, incluida la de alcance |
| `src/appstore-client.ts` | Cliente de App Store Connect: firma JWT ES256 y peticiones `GET` |
| `src/scope.ts` | Comprobación de alcance por app antes de cualquier petición |
| `src/sales-report.ts` | Lectura del informe de ventas (TSV comprimido con gzip) |
| `src/logger.ts` | Logs a `stderr` con redacción de secretos |
| `src/server.ts` | Servidor MCP: registro de herramientas y despacho |
| `src/stdio.ts` | Entrada por stdio; instala la redirección de `console` a `stderr` |
| `test/` | Suite con fixtures, sin red y sin credenciales reales |

---

## 3. Inventario de herramientas

`src/tools.ts` es el inventario. La suite comprueba que el conjunto registrado en el servidor
coincide **exactamente** con esa lista y que ninguna herramienta de escritura está presente: el
prefijo de verbo (`create`, `update`, `delete`, `submit`, …) hace fallar el test.

Un argumento desconocido, ausente o fuera de rango se rechaza antes de emitir cualquier petición de
red.

---

## 4. Identificadores de app y alcance

`APPLE_APP_ID` y `APPLE_APP_STORE_SKU` no son intercambiables:

| Variable | Identificador | Dónde se ve |
| --- | --- | --- |
| `APPLE_APP_ID` | App Store Connect app id, el `id` opaco del recurso `apps` | Es el valor que las tools aceptan como `appId`; `list_apps` lo imprime como "App id" |
| `APPLE_APP_STORE_SKU` | App Store ID, el atributo `sku` del recurso `apps` | El número visible en App Store Connect y en la App Store; `list_apps` lo imprime como "App Store id" |

Si se define más de una variable de alcance, **todas** tienen que coincidir: el alcance no se puede
ampliar definiendo una segunda variable.

`APPLE_APP_STORE_ID` ya no se acepta. Era ambiguo (se documentaba como App Store ID pero las tools
identifican la app por su `id`) y el servidor lo rechaza al arrancar con un mensaje que indica la
variable correcta, en lugar de interpretar el valor de una forma que pudiera denegar la app
permitida.

---

## 5. Informe de ventas

`get_sales_report` lee el informe diario de ventas de la cuenta. El informe de Apple no es JSON: es
un **TSV comprimido con gzip**, con columnas nombradas y con filas de varias monedas mezcladas.

- Se pide el subtipo `SUMMARY` y la frecuencia `DAILY`. Sin `filter[reportSubType]`, Apple responde `400`.
- El número de proveedor se toma de `APPLE_VENDOR_NUMBER`. No es el `issuerId` ni el App Store ID: Apple rechaza la petición con el valor equivocado.
- Las columnas se leen por nombre, no por posición, y cada columna admite varias grafías (`Units`/`Quantity`, `Developer Proceeds`/`Proceeds`, `SKU`/`Apple Identifier`).
- **Los importes nunca se suman entre monedas.** Cada moneda tiene su propia cifra y los importes se redondean a céntimos en cada paso, para que la aritmética binaria no desplace el resultado.
- La fecha por defecto es **ayer**: Apple genera el informe diario durante el día siguiente, así que el informe de hoy todavía no existe.
- Se distinguen dos casos que Apple responde igual con un `404`: un día **sin ventas** y un informe **aún no generado**. Solo el detalle del error los separa.

El informe pertenece a la cuenta, no a una app: lista todas las apps del proveedor. La herramienta es de
alcance por app, así que solo devuelve las unidades y los ingresos de la app solicitada.

El análisis de TSV, gzip y multicolumna vive en `src/sales-report.ts` y está cubierto por pruebas
deterministas, con fixtures sintéticos del layout de columnas de Apple.

---

## 6. Transporte stdio

`stdout` transporta exclusivamente tramas JSON-RPC del protocolo MCP. Todos los diagnósticos, avisos
y trazas van a `stderr`.

La redirección de `console` a `stderr` se instala antes de importar cualquier otro módulo, de modo que
una dependencia que registre al importarse no puede corromper el flujo del protocolo.

Si falta la configuración obligatoria, el servidor escribe el error en `stderr`, deja `stdout` vacío y
termina con código distinto de cero.

---

## 7. Seguridad de los logs

- Todos los diagnósticos van a `stderr`; `stdout` nunca lleva texto que no sea JSON-RPC.
- Los valores secretos se redactan antes de escribir: claves con nombre de secreto (`privateKey`, `authorization`, `token`, …) se sustituyen por una huella no reversible.
- El material secreto incrustado en texto libre también se redacta: bloques PEM, tokens `Bearer` y pares `clave: valor`.
- Las cadenas largas se truncan.

---

## 8. Comparación con `ryaker/appstore-connect-mcp`

Este repositorio **no** es una copia ni un superconjunto de
[ryaker/appstore-connect-mcp](https://github.com/ryaker/appstore-connect-mcp) (MIT), que sigue siendo
la referencia del dominio.

| | upstream | este repositorio |
| --- | --- | --- |
| Herramientas | 15, incluidas de escritura | 7, todas de lectura |
| Transporte | HTTP, stdio y SSE, con OAuth2/Auth0 | stdio local |
| Empaquetado | npm, Docker, Vercel, Smithery, MCP Registry | npm |
| Autenticación | clave de API o OAuth2/Auth0 | clave de API (`.p8`) |
| Pruebas | scripts contra la API real | suite con fixtures, sin red, en CI |

Lo que este repositorio hace mejor:

- **La escritura no existe por construcción.** El inventario vive en `src/tools.ts` y la suite comprueba que el conjunto registrado coincide exactamente con esa lista y que ninguna herramienta de escritura está presente.
- **El alcance por app se comprueba antes de cualquier petición**, no después.
- **`stdout` queda reservado al protocolo**; diagnósticos y trazas van a `stderr`, y los secretos se redactan antes de escribirse.
- **El informe de ventas se lee como el informe que es**: TSV comprimido por gzip, subtipo `SUMMARY`, ingresos por moneda y sin sumar nunca importes de monedas distintas. Upstream mantiene su equivalente roto en `main`; su PR #5 lo corrige (verificado el 2026-11-17: sigue abierto).

Pendiente de adoptar de upstream: el transporte HTTP con el servidor atado a `127.0.0.1` por defecto
(PR #6, también abierto). El requisito queda escrito en la sección 12.

---

## 9. Publicación en npm

El paquete se publica en el registro público de npm como
`@davidneyra2804/appstoreconnect-mcp`.

`.github/workflows/publish.yml` publica cuando se publica una release (o a mano, con
`workflow_dispatch`). La autenticación usa OIDC: npm cambia la identidad del runner por un token de
publicación de corta duración, así que el repositorio no guarda ningún secreto de npm.

La publicación genera un artefacto de procedencia (`--provenance`): npm firma de forma criptográfica
que el tarball salió de este repositorio y de este workflow. El flag se pasa en el propio comando,
**no** en `publishConfig`, porque npm solo genera procedencia dentro de GitHub Actions o GitLab CI: si
se fijara en `publishConfig`, una publicación manual desde un portátil fallaría.

### Trusted publishing: configuración en npm

Se configura **en la página del paquete ya publicado**, no en este repositorio:

1. Entrar en [npmjs.com](https://www.npmjs.com) con la cuenta que publica.
2. Ir a **Packages** → `@davidneyra2804/appstoreconnect-mcp` → **Settings**.
3. En **Trusted publishing**, activar el *trusted publisher* para GitHub Actions.
4. Rellenar:
   - **Organization or user account**: `davidneyra2804`
   - **Repository**: `appstoreconnect-mcp`
   - **Workflow filename**: `publish.yml` (solo el nombre del fichero, **sin** la ruta `.github/workflows/`)
5. Guardar.

Puntos que hay que comprobar al configurarlo:

- **Permisos de publicación.** Las configuraciones creadas a partir de 2026-09-03 vienen con **solo** `npm stage publish` permitido. Hay que marcar explícitamente `npm publish` para que este workflow funcione tal cual.
- **Caducidad.** La configuración **caduca** si no completa su primera publicación en los 2 días siguientes a crearla.
- **Cerrar el acceso por token.** Una vez configurado y probado el *trusted publisher*, conviene ir a **Settings → Publishing access** y desactivar la publicación con token: la OIDC queda como único camino y deja de haber un token de larga vida que se pueda filtrar.
- **La primera publicación hay que hacerla a mano**, porque el *trusted publisher* solo se puede crear una vez que el paquete existe en el registro.

### Publicar una versión

```bash
npm version patch        # actualiza package.json y package-lock.json
npm ci
npm run build
npm test
npm pack --dry-run       # comprueba qué entra en la tarball

git tag v0.1.3 && git push origin v0.1.3
```

La release dispara `.github/workflows/publish.yml`, que compila, comprueba los tipos, pasa la suite,
verifica la tarball y publica.

El número de versión de `package.json` es el que se publica y tiene que coincidir con el de la tag de
la release; el workflow falla si no coinciden. Las versiones publicadas son inmutables: corregir algo
exige una versión nueva.

La versión que el servidor anuncia en el saludo MCP se lee de `package.json` en tiempo de ejecución,
así que un cliente ve siempre la versión del paquete que tiene instalado, no una constante que pueda
quedarse desfasada.

### La versión `0.0.0-stage` que aparece en el registro

El registro muestra además una versión `0.0.0-stage` que no es una versión real: es un marcador de dos
ficheros (~357 bytes) que quedó al probar el flujo de *staging* de npm. No está en `latest` y no
afecta a la instalación ni a `npx`, pero se ve al listar las versiones.

Se puede rechazar, y solo lo puede hacer el propietario:

```bash
npm stage list                       # ver el stage pendiente
npm stage reject <stage-id>          # quitarlo del registro
```

Rechazarlo es una decisión del mantenedor, no un paso obligatorio.

### Alternativa: `npm stage publish`

npm recomienda una variante de Trusted Publishing en la que la CI **solo** empaqueta y sube la
versión a *staging*, y el propietario la aprueba con su 2FA desde la web. En esa variante:

- npm solo permite `npm stage publish`, y `npm publish` queda deshabilitado.
- El workflow usa `npm stage publish` en lugar de `npm publish`.
- La versión queda pendiente en npmjs.com hasta que el propietario la aprueba.

La ventaja es que nada llega a `latest` sin una confirmación humana explícita. La desventaja es un
paso manual por versión y que el *staging* de npm no es un canal con SLA ni métricas como el registro
normal.

Para este paquete, que es de un solo mantenedor y publica pocas versiones, la opción recomendada es
**Trusted Publishing con `npm publish` y aprobación por release de GitHub**: la tag de la release ya es
el acto explícito y deliberado que autoriza la publicación, y el circuito es más corto.

---

## 10. Problemas habituales

### Instalación

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `npm error engine Unsupported engine` | Node anterior a 18 | Instalar Node 18 o posterior. El paquete es ESM puro y `type: module` |
| `npm error cannot find module .../dist/stdio.js` al arrancar | Se instaló una tarball empaquetada sin compilar | No ocurre con las versiones publicadas: el script `prepack` compila antes de empaquetar. Si se ve, es una instalación local de una tarball creada a mano |
| `EACCES` al escribir en la caché de npm (`.../_cacache/tmp`) al iniciar con `npx` | El usuario que ejecuta el cliente MCP no puede escribir en la caché configurada para npm en ese host | Añadir `npm_config_cache` al bloque `env` de ese servidor y asignarle una ruta que el usuario del cliente pueda crear y escribir. Corrige permisos de instalación del host; no cambia las credenciales ni los permisos de App Store Connect |
| `command not found: appstoreconnect-mcp` tras `npm install --global` | El directorio global de npm no está en el `PATH` | Comprobar `npm bin -g` (o `npm prefix -g`) y añadirlo al `PATH` |
| `npx` se queda colgado sin responder | Se está esperando una entrada por `stdin` | Es el comportamiento normal: el servidor espera tramas JSON-RPC. Ctrl+C para salir |

### Autenticación

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `Configuration error {message=Missing required environment variable(s): APPLE_KEY_ID, APPLE_ISSUER_ID, APPLE_PRIVATE_KEY or APPLE_PRIVATE_KEY_PATH.}` en `stderr`, con `stdout` vacío | Falta la configuración obligatoria | Rellenar `APPLE_KEY_ID`, `APPLE_ISSUER_ID` y una de las dos variables de clave privada. El error sale en `stderr` y `stdout` queda vacío a propósito |
| `401` o `403` al llamar a la API | La clave `.p8` no corresponde al `issuerId`, o la clave está revocada | Revisar que la clave y el `issuerId` son del mismo equipo de App Store Connect |
| `403` con `GET /v1/apps` | La clave de API no tiene permiso de acceso a los recursos | Regenerar la clave en App Store Connect → Integraciones |
| La clave se pasa por variable de entorno y no por fichero | `APPLE_PRIVATE_KEY` con el PEM en bruto o en base64 | Ambas formas valen. Para un fichero, `APPLE_PRIVATE_KEY_PATH` es lo más simple y evita el pegado de saltos de línea |
| El servidor no ve las variables | El cliente MCP las pasa en su propio bloque `env` | Comprobar el bloque `env` de la configuración del cliente: el proceso hijo solo hereda lo que se declare ahí |

### Publicación

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `npm error This command requires you to be logged in` | No hay *trusted publisher* configurado para este repositorio y este workflow, o falta el permiso `id-token: write` | Configurarlo en npmjs.com → Packages → Settings → Trusted publishing, con el nombre de workflow `publish.yml` |
| `npm error 402 Payment required` / `EOTP` | La versión ya existe en el registro | Subir la versión. Las versiones publicadas son inmutables |
| `npm error Invalid package name` o `cannot publish over` | La versión de `package.json` no coincide con la de la tag, o la versión ya está publicada | Revisar la tag y la versión de `package.json` |
| `npm warn No bin file found at dist/stdio.js` | La tarball se empaquetó sin compilar | `prepack` compila antes de empaquetar. Si aparece, es que la compilación falló: mirar el paso de build |
| `npm error unsupported engine` | Node anterior a 18 | Node 18 o posterior |

Reglas de npm que condicionan el flujo: la CLI 11.5.1 o posterior y Node 22.14 o posterior para OIDC;
el *trusted publishing* solo se configura en la página de un paquete ya existente; y la procedencia
(`--provenance`) solo se genera dentro de GitHub Actions o GitLab CI.

---

## 11. Desarrollo, pruebas y CI

```bash
npm run build                 # compilar a dist/
npm test                      # suite completa (mocks y fixtures, sin red)
npx tsc -p tsconfig.test.json # comprobación de tipos de src/ y test/
```

La suite usa fixtures y una clave ES256 generada en memoria: no se usa ninguna credencial real de
Apple.

`.github/workflows/ci.yml` ejecuta `npm ci`, `npm run build`, `npx tsc -p tsconfig.test.json` y
`npm test` en cada push a `main` y en cada pull request, con la matriz de Node 18 y 20. El pipeline
también comprueba que el repositorio no menciona a ninguna organización.

---

## 12. Transporte HTTP (fase posterior)

El transporte HTTP **no está implementado**. Cuando se aborde, quedan fijados estos requisitos:

- **Escucha en `127.0.0.1` por defecto**, nunca en `0.0.0.0`. `HOST` documentado para cambiarlo de forma explícita.
- **OAuth es condición para exponerlo.** Un servidor HTTP sin autenticación no se publica: upstream acepta peticiones sin autenticar cuando `OAUTH_ENABLED` no está definido, y ese hueco no se reproduce aquí.

Referencia: upstream PR #6.
