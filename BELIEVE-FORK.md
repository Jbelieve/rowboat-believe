# Believe Brain Client — contrato de build del fork

Fork de `rowboatlabs/rowboat` (`apps/x/`, Electron) → cliente unificado del Company Brain de Believe.
PRD: believe-os `specs/rowboat-fork/PRD.md`. Rama: `believe/brain-client`. Upstream se mantiene rebaseble: **todo aditivo, mínima divergencia**.

## Contrato del Company Brain (verificado 2026-07-08 contra get-maas)

- Proyecto Supabase getmaas: `vyllsxqkfefijdbqfgop`.
- **Escritura**: `POST https://vyllsxqkfefijdbqfgop.supabase.co/functions/v1/mc-company-brain-ingest`
  - Header `x-api-key: mc_<8hex>_<rest>` (NO Bearer). Scope requerido: `company_brain:write`.
  - Body batch: `{ "episodes": [ { source, external_id, actors[], summary, decision_summary?, transcript_ref? (<=8000 chars), client_id?, channel, metadata{}, created_at? ISO } ] }`.
  - `source` es CHECK duro en DB: `omi|mattermost|gmail|n8n|maasy|advault|clips|manual`. El desktop usa **`manual`** con `channel:"desktop"`.
  - Idempotencia: UNIQUE(source, external_id), upsert; reenvío → `skipped`. external_id del desktop: `desktop:<ruta-relativa-de-la-nota>`.
  - Respuesta 200 `{ok:true, ingested:{...}, skipped:{...}}`; 401/403/429/400/500.
  - La firma HMAC X-Omi-Signature es convención de productor, la EF NO la valida. No implementarla; el secreto real es el token.
- **Lectura (pull)**: `POST .../functions/v1/mc-brain-query` — scope `company_brain:read`.
  - Body `{ entity:"episodes", filters:{ sources?, channel?, client_id?, since?:ISO, until?:ISO }, limit (max 200), offset }` → `{ok, entity, count, rows}` (sin embedding).
  - Pull incremental: `since = max(created_at) visto` + paginación por offset. OJO: created_at puede venir retroactivo (omi setea fecha de la conversación) → usar watermark con margen de solape (p.ej. since = watermark - 24h) + dedup por id/external_id.

## Módulos a construir (todos en `apps/x/packages/core/src/`)

Patrón canónico: `knowledge/sources/sync_slack.ts` (leerlo entero antes de codear). Registro: enum en `knowledge/sources/types.ts` + BUILTIN_SOURCES en `knowledge/sources/repo.ts`. El pipeline arranca desde `knowledge/build_graph.ts processAllSources()`.

1. **`brain/transport.ts`** — cliente HTTP del brain: `queryEpisodes({since, offset, limit})` y `ingestEpisodes(episodes[])` contra las 2 EFs. Config en `config/company_brain_config.ts` leyendo `WorkDir/config/company_brain.json` `{ apiUrl, apiKey, enabled, pullIntervalMs?, pushIntervalMs? }` (patrón de gmail_sync_config.ts). Inyectable/mockeable (interfaz de transporte, fetch inyectado).
2. **`knowledge/sources/sync_company_brain.ts`** (CompanyBrainSource) — clon del patrón sync_slack: provider `company_brain`, syncMode poll, pull por mc-brain-query, escribe artifacts frontmattered en `knowledge_sources/company_brain/<source>/<external_id-safe>-<hash8>.md` (sufijo sha256[0:8] del external_id contra colisiones por truncado a 120 chars), estado `company_brain_sync_state.json` (watermark lastCreatedAt clampeado a now(), backoff), idempotente (writeArtifact devuelve null si no cambió). Frontmatter EXACTO del patrón slack (source, source_id, external_id, version, occurred_at). **Dueño del pull: BrainSyncEngine, EXCLUSIVAMENTE** — el hook en `processAllSources()` de build_graph.ts se quitó (hardening 2026-07-08) para que GraphBuilder (15s) y el engine (60s) no corran el pull en paralelo; además `syncCompanyBrainKnowledgeSources` tiene guard in-flight (llamadas concurrentes comparten la promesa en curso). Filtro de eco: descarta SOLO `desktop:<deviceId-propio>:` — las notas desktop de OTROS dispositivos sí se materializan. Dedup por id solo DENTRO del run (páginas repetidas); entre runs manda writeArtifact idempotente, así las ediciones centrales dentro de la ventana de solape re-escriben el artifact (central gana). Episodios sin created_at: no mueven el watermark y llevan version estable derivada del id.
3. **`brain/fanout.ts`** (EpisodeFanoutProducer) — escanea `WorkDir/knowledge/*.md` nuevas/cambiadas con estado mtime+hash propio (`brain_fanout_state.json`, patrón graph_state.ts), normaliza nota→episode (source manual, external_id `desktop:<deviceId>:<relpath>` con deviceId de 8 hex autogenerado y persistido en company_brain.json, summary = primeras líneas/título, transcript_ref = cuerpo <=8000, channel desktop, metadata {path, wikilinks[]}), `emit(transport)` en **chunks de 25** persistiendo estado tras CADA chunk exitoso. Errores: red/5xx/429 → paran el run y se reintenta el próximo tick desde donde quedó; 4xx determinístico (bad_request) → bisección hasta aislar la nota venenosa, que acumula failCount y se salta tras 3 fallos sin bloquear el resto. NO re-emitir notas cuyo origen sea el propio pull del brain (solo knowledge/; y saltar notas cuyo frontmatter tenga `brain_origin: central`).
4. ~~**`brain/authority.ts`** (AuthorityResolver)~~ — **ELIMINADO** (hardening 2026-07-08): estaba muerto (nunca cableado). La regla central-gana vive inline en el pull de sync_company_brain.ts — todo episodio dentro de la ventana de solape pasa por el writeArtifact idempotente, así el contenido central sobrescribe el artifact local en conflicto.
5. **`brain/sync_engine.ts`** (BrainSyncEngine) — orquesta: `init()` con loop while(true) + interruptibleSleep (patrón granola/sync.ts, try/catch POR TICK para no morir silenciosamente), tick = pull (via sync_company_brain) + push (via fanout). `triggerSync()` exportado. Registrar `initBrainSync()` en `apps/main/src/main.ts` junto a initGranolaSync (~línea 510). Status exportado para IPC futura.
6. **`knowledge/sources/sync_mattermost.ts`** — conector Be Chat: provider `mattermost`, poll REST API v4 de Mattermost (`MM_URL/api/v4`, token en `WorkDir/config/mattermost.json` `{ url, token, channels[] }`): posts nuevos por canal paginando `GET /channels/{id}/posts?page=N&per_page=200` hasta página corta o hasta cruzar el watermark (NO `?since=`, que la API capa y pierde posts en el primer sync o en ráfagas grandes), artifacts frontmattered como slack. Estado propio con lastPostAt por canal.

### Notas de diseño (hardening post-review 2026-07-08)

- **Eco de segundo orden — aceptado por diseño**: una nota generada por el LLM local a partir de artifacts del brain (que vive en `knowledge/` sin `brain_origin: central`) se re-empuja al brain como `manual`. Es conocimiento nuevo destilado, no un eco literal; el eco de primer orden (artifacts pulled) sí se filtra por frontmatter y por prefijo `desktop:<deviceId-propio>:`.
- **Configs con secretos** (`company_brain.json`, `mattermost.json`): chmod 0600 se re-aplica también al leer/reescribir archivos preexistentes.
- **safeSegment** neutraliza `..` y separadores en todos los segmentos derivados de datos del server (un external_id/canal malicioso no puede escapar del artifactDir).

## Reglas duras

- **pnpm, NO npm** (workspace:* deps). Build: `cd apps/x && pnpm run deps`. Tests: `pnpm test` (vitest). Línea base actual: 387 tests verdes — NO romper ninguno.
- Tests nuevos: patrón `sync_slack.test.ts` (ROWBOAT_WORKDIR=tmpdir seteado ANTES del import dinámico, mocks de repo/service_logger, fixtures de respuestas HTTP — CERO red real).
- No tocar el pipeline LLM (label→graph→tag) ni el renderer salvo lo mínimo. No reformatear código ajeno.
- **Desactivar auto-update upstream**: en `apps/main/src/main.ts` (~362) el updateElectronApp apunta a rowboatlabs/rowboat — gatearlo con env/flag o comentarlo con marca `// believe:`.
- Cambios marcados: comentario `// believe:` en cada punto de contacto con código upstream para rebases futuros.
- Secrets: apiKey solo en `WorkDir/config/company_brain.json` (600). Nunca hardcodear tokens reales; en tests usar `mc_deadbeef_test`.
- TypeScript estricto del repo; zod para schemas nuevos (patrón types.ts).
