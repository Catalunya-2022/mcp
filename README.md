# Servidor MCP de Catalunya 2022

[![CI](https://github.com/catalunya-2022/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/catalunya-2022/mcp/actions/workflows/ci.yml)
[![Versió](https://img.shields.io/github/package-json/v/catalunya-2022/mcp?label=versi%C3%B3)](https://mcp.2022.cat/health)
[![DOI](https://img.shields.io/badge/DOI-10.5281%2Fzenodo.19500831-blue)](https://doi.org/10.5281/zenodo.19500831)

Servidor MCP remot per al document **«Catalunya 2022 - RESET: Crida per reactivar el país»**, el pla estratègic elaborat l'any 2021 per un grup de treball de 30 experts de la societat civil catalana. Exposa els 3 àmbits, els 12 objectius, les 91 accions i els perfils dels contribuïdors en català, anglès i castellà mitjançant eines, recursos i prompts MCP.

## Connexió

Endpoint públic: `https://mcp.2022.cat` (transport Streamable HTTP, sense autenticació ni claus API). El servidor parla les dues generacions del protocol des d'un sol endpoint: la revisió 2026-07-28 (sense handshake, amb `server/discover`) i les revisions 2025-xx per als clients que encara fan `initialize`.

```json
{ "url": "https://mcp.2022.cat" }
```

- Instruccions per client (Claude, ChatGPT, Cursor, VS Code, Cline, Continue…): [2022.cat/mcp](https://2022.cat/mcp)
- Registre MCP oficial: [`cat.2022/catalunya-2022`](https://registry.modelcontextprotocol.io/v0/servers?search=catalunya)
- Lloc web del document: [2022.cat](https://2022.cat) · [repositori](https://github.com/catalunya-2022/web)

## Superfície MCP pública

### Eines

- `search_document`: cerca de text complet amb suport de diacrítics
- `get_section`: text complet de qualsevol secció per slug canònic
- `get_document_metadata`: estructura completa del document
- `list_proposals`: llistat de les 91 accions

### Recursos

- `document://catalunya2022/manifest`
- `document://catalunya2022/{locale}/{slug}`
- `document://catalunya2022/{locale}`: el document sencer en un sol fitxer markdown
- `document://catalunya2022/contributors`

### Prompts

- `explore-document`
- `summarize-sphere`
- `analyze-proposal`

## Desenvolupament

Requisits: Node.js 22+ i npm.

```bash
npm install
npm run dev
```

`npm run dev` regenera el corpus abans d'iniciar el servidor local:

- `http://localhost:3001/`: endpoint MCP
- `http://localhost:3001/health`: comprovació de salut

### Comprovacions de qualitat

```bash
npm run lint        # format i lint amb Biome
npm run typecheck   # TypeScript estricte (inclou locals i paràmetres no usats)
npm run test        # reconstrueix corpus i dist, executa la suite de regressió
npm run verify      # validació completa local, equivalent a CI
```

Altres ordres: `npm run build-corpus` (regenera `data/corpus.json` des de l'MDX), `npm run start` (executa el servidor compilat), `npm run fixtures:update` (regenera els fixtures daurats de `tests/fixtures/`; revisa el diff resultant), i `npm run sync` / `npm run sync-check` (vegeu la nota sobre contingut sincronitzat).

Executa `npm run verify` abans d'obrir un pull request. Els tests s'executen contra la sortida compilada a `dist/`: fes servir sempre els scripts npm, que reconstrueixen primer.

### Estructura del projecte

```text
assets/         Icones del servidor (servides a /icon.svg i /icon.png)
content/        Fitxers MDX trilingües d'origen
data/           Constants, tipus, catàleg de rutes, contribuïdors, corpus generat
scripts/        Generació del corpus, sincronització de contingut i regeneració de fixtures
src/            Runtime del servidor MCP
tests/          Tests de contracte, regressió i utilitats
server.json     Manifest per al registre MCP oficial
```

### Contingut sincronitzat

`content/{ca,en,es}/` i `data/team-members.ts` són **miralls generats** del [repositori del lloc web](https://github.com/catalunya-2022/web), la font de veritat del text del document. No els editis aquí: qualsevol canvi s'ha de fer al repositori d'origen i es propaga amb `npm run sync` (que registra la procedència a `data/content-provenance.json`). Per defecte el repositori del lloc web s'espera a `../web` (clonat al costat d'aquest); la variable d'entorn `CAT22_WEBSITE_DIR` permet indicar una altra ubicació. `npm run sync-check` detecta desviacions quan el repositori germà està disponible i s'omet netament quan no ho està (per exemple, a CI).

### Notes de publicació

- Els slugs canònics són sempre en anglès, encara que el contingut estigui localitzat.
- La llengua per defecte és el català (`ca`).
- El fitxer generat `data/corpus.json` no es versiona: `npm run dev`, `npm run build` i `npm test` el regeneren a partir de l'MDX versionat, i la CI el valida a cada desplegament.
- **Contracte públic**: els noms de les eines MCP, els URIs dels recursos, els noms dels prompts, els slugs canònics, les formes JSON de resposta i el locale per defecte són API pública. No els canviïs sense una intenció explícita i documentada.
- Si canvies `content/`, `data/` o la lògica de traducció d'URLs, regenera el corpus i revisa amb cura els fixtures de regressió.

---

## English

Remote MCP server for the policy document **"Catalunya 2022 - RESET: Call to reactivate Catalonia"**, a strategic plan written in 2021 by a 30-expert Catalan civil-society task force. It exposes the document's 3 spheres, 12 goals, 91 actions, and contributor profiles in Catalan, English, and Spanish through MCP tools, resources, and prompts.

**Connect**: public endpoint at `https://mcp.2022.cat` (Streamable HTTP, no authentication):

```json
{ "url": "https://mcp.2022.cat" }
```

Per-client setup instructions: [2022.cat/mcp](https://2022.cat/mcp) · Official MCP Registry: `cat.2022/catalunya-2022` · Document website: [2022.cat](https://2022.cat) · Website code: [github.com/catalunya-2022/web](https://github.com/catalunya-2022/web) · Archived document DOI: [10.5281/zenodo.19500831](https://doi.org/10.5281/zenodo.19500831)

Development commands are language-neutral; see [Desenvolupament](#desenvolupament) above.

## Llicències / Licenses

- **Codi / Code**: [MIT](LICENSE)
- **Contingut del document / Document content** (`content/`): [CC BY 4.0](LICENSE-content) - Grup de Treball Catalunya 2022. *Catalunya 2022 - RESET: Crida per reactivar el país.* DOI: [10.5281/zenodo.19500831](https://doi.org/10.5281/zenodo.19500831)
