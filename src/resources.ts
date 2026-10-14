import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import { DOCUMENT_TITLE } from "../data/constants.js";
import { buildWebsiteUrl, toCanonicalSlug } from "../data/route-catalog.js";
import { isLocale, LOCALES } from "../data/types.js";
import {
  getCorpus,
  getSection,
  renderFullDocumentMarkdown,
  renderSectionMarkdown,
  suggestSlug,
} from "./corpus.js";
import {
  buildManifest,
  buildSectionResourceList,
  DOCUMENT_URI_BASE,
  fullDocumentResourceUri,
  parseSectionResourceRef,
} from "./document-utils.js";

let manifestJson: string | undefined;
let documentResourceList: Array<{ uri: string; name: string; title: string }> | undefined;
let contributorsJson: string | undefined;

function getManifestJson(): string {
  manifestJson ??= JSON.stringify(buildManifest(getCorpus()));
  return manifestJson;
}

// Entries carry their own name (programmatic ref), title (human), and, for the
// full-document rows, description. Fields an entry omits are inherited from
// the template registration, whose generic title/description fit no single row.
function getDocumentResourceList() {
  documentResourceList ??= [
    ...LOCALES.map((locale) => ({
      uri: fullDocumentResourceUri(locale),
      name: locale,
      title: `${DOCUMENT_TITLE} (full document, ${locale})`,
      description: `The whole document as one markdown file, ${locale} edition`,
    })),
    ...buildSectionResourceList(getCorpus()),
  ];
  return documentResourceList;
}

function getContributorsJson(): string {
  contributorsJson ??= JSON.stringify(getCorpus().contributors);
  return contributorsJson;
}

function jsonContents(uri: URL, text: string) {
  return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
}

function markdownContents(uri: URL, text: string) {
  return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
}

function readDocumentResource(uri: URL, params: Record<string, string | string[]>) {
  const ref = typeof params.ref === "string" ? params.ref : "";

  if (isLocale(ref)) {
    return markdownContents(uri, renderFullDocumentMarkdown(ref));
  }

  const parsedRef = parseSectionResourceRef(ref);
  if (!parsedRef) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid resource URI. Expected ${DOCUMENT_URI_BASE}/{locale}/{slug} for a section or ${DOCUMENT_URI_BASE}/{locale} for the full document (locales: ca, en, es).`,
    );
  }

  // Accept localized URL segments here too ("es/ambito-1" reads sphere-1).
  const canonicalSlug = getSection(parsedRef.slug) ? parsedRef.slug : toCanonicalSlug(parsedRef.slug);
  const section = getSection(canonicalSlug);
  if (!section) {
    const suggestion = suggestSlug(canonicalSlug);
    throw new ResourceNotFoundError(
      uri.href,
      `Resource not found: ${uri.href}.${
        suggestion ? ` Did you mean ${DOCUMENT_URI_BASE}/${parsedRef.locale}/${suggestion}?` : ""
      } Use resources/list or get_document_metadata to see all valid sections.`,
    );
  }

  return markdownContents(
    uri,
    renderSectionMarkdown(
      canonicalSlug,
      buildWebsiteUrl(canonicalSlug, parsedRef.locale),
      section.content[parsedRef.locale],
    ),
  );
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    "manifest",
    `${DOCUMENT_URI_BASE}/manifest`,
    {
      title: "Document manifest",
      description: "Full document hierarchy with trilingual titles",
      mimeType: "application/json",
    },
    (uri) => jsonContents(uri, getManifestJson()),
  );

  // The two fixed resources above and below always win over this template:
  // the SDK resolves exact URI registrations before templates, so the
  // catch-all only ever sees bare-locale and locale/slug refs.
  server.registerResource(
    "section",
    new ResourceTemplate(`${DOCUMENT_URI_BASE}/{+ref}`, {
      list: () => ({ resources: getDocumentResourceList() }),
      complete: {
        ref: (value) =>
          getDocumentResourceList()
            .map((resource) => resource.name)
            .filter((ref) => ref.startsWith(value ?? ""))
            .slice(0, 100),
      },
    }),
    {
      title: "Document sections",
      description:
        "Any section of the Catalunya 2022 document, or the whole document as one markdown file. The template has a single path variable: ref = {locale} for the full document, or {locale}/{slug} for a section (locales: ca, en, es).",
      mimeType: "text/markdown",
    },
    (uri, params) => readDocumentResource(uri, params),
  );

  server.registerResource(
    "contributors",
    `${DOCUMENT_URI_BASE}/contributors`,
    {
      title: "Task force contributors",
      description:
        "All 30 task force expert contributors with trilingual roles and bios, Wikidata ids, and verified social links",
      mimeType: "application/json",
    },
    (uri) => jsonContents(uri, getContributorsJson()),
  );
}
