import { McpServer } from "@modelcontextprotocol/server";
import { DOCUMENT_TITLE } from "../data/constants.js";
import { DOCS_URL, SERVER_DESCRIPTION, SERVER_ICONS, SERVER_NAME, SERVER_VERSION } from "./identity.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

const instructions = [
  "Aquest servidor dóna accés al document «Catalunya 2022 - RESET: Crida per reactivar el país», una proposta estratègica creada per 30 experts de la societat civil catalana. Cobreix una societat justa (Àmbit 1), una economia competitiva (Àmbit 2) i el sector públic (Àmbit 3), amb 3 àmbits, 12 objectius i 91 accions. Disponible en català (ca), anglès (en) i castellà (es).",
  'This server provides access to the policy document "Catalunya 2022 - RESET: Call to reactivate Catalonia", a strategic proposal by a task force of 30 Catalan civil-society experts. It covers a fair society (Sphere 1), a competitive economy (Sphere 2), and the public sector (Sphere 3) across 3 spheres, 12 goals, and 91 actions. Available in Catalan (ca), English (en), and Spanish (es).',
  "Este servidor da acceso al documento «Catalunya 2022 - RESET: Llamamiento para reactivar el país», una propuesta estratégica creada por 30 expertos de la sociedad civil catalana. Cubre una sociedad justa (Ámbito 1), una economía competitiva (Ámbito 2) y el sector público (Ámbito 3), con 3 ámbitos, 12 objetivos y 91 acciones. Disponible en catalán (ca), inglés (en) y castellano (es).",
  "",
  "Start with get_document_metadata to understand the structure (it includes the formal citation with DOI), or search_document to find specific topics. Read one section via get_section, browse resources (document://catalunya2022/manifest, contributors, {locale}/{slug}), or load the whole document from document://catalunya2022/{locale}. Use prompts (explore-document, summarize-sphere, analyze-proposal) for guided interactions.",
].join("\n");

/** Content is frozen, so list and read results can be cached generously by clients. */
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PUBLIC_DAY = { ttlMs: DAY_MS, cacheScope: "public" as const };

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: DOCUMENT_TITLE,
      description: SERVER_DESCRIPTION,
      websiteUrl: DOCS_URL,
      icons: SERVER_ICONS,
    },
    {
      instructions,
      cacheHints: {
        "tools/list": PUBLIC_DAY,
        "prompts/list": PUBLIC_DAY,
        "resources/list": PUBLIC_DAY,
        "resources/templates/list": PUBLIC_DAY,
        "resources/read": PUBLIC_DAY,
        "server/discover": { ttlMs: HOUR_MS, cacheScope: "public" },
      },
    },
  );

  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
}
