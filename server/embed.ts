/**
 * Injection of the optional `window.__DICOM_BOOTSTRAP__` payload into the
 * viewer HTML for hosts without the MCP Apps bridge (`--embed-series`).
 */
import { BOOTSTRAP_GLOBAL, type DicomBootstrap } from "../shared/protocol.js";

/**
 * JSON that is safe inside an inline `<script>`: `<`, `>`, `&`, U+2028 and
 * U+2029 are written as `\uXXXX` escapes, so no data can close the script
 * element, open a comment, or break older JS parsers. Still valid JSON/JS.
 */
export function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Inserts the bootstrap script before `</head>` (or at the top of the document). */
export function injectBootstrap(html: string, bootstrap: DicomBootstrap): string {
  const script = `<script>window.${BOOTSTRAP_GLOBAL} = ${serializeForInlineScript(bootstrap)};</script>`;
  // Function replacers: `$&`, `$1`, `$$` sequences in the data stay literal.
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, (match) => `${script}${match}`);
  }
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body[^>]*>/i, (match) => `${match}${script}`);
  }
  return `${script}${html}`;
}
