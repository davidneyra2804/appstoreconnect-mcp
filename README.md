# appstoreconnect-mcp

Servidor MCP (Model Context Protocol) para la API de App Store Connect de Apple.

Proyecto de **VYR TECH SOLUTIONS**.

## Estado

En desarrollo. El diagnóstico técnico y el plan de trabajo están entregados en Paperclip
(VYRA-48) y la tarea principal (VYRA-47) está pendiente de arranque. Este repositorio
recibe el código por ramas (`feature/...`, `fix/...`) con PR a `main`.

- Tarea principal: https://paperclip.davidneyra.dev/VYRA/issues/VYRA-47
- Plan entregado: https://paperclip.davidneyra.dev/VYRA/issues/VYRA-48

## Alcance

Por precisar aquí, a partir del plan entregado.

## Credenciales

La API de App Store Connect se autentica con una clave privada `.p8` y un `issuerId`. Las
credenciales se dan por variables de entorno o gestor de secretos: nunca se versionan en
este repositorio.

## Licencia

Todavía sin licencia, se añadirá cuando el alcance esté cerrado.
