import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  MAX_SLICES_PER_REQUEST,
  SLICES_TOOL_NAME,
  VIEW_TOOL_NAME,
  VIEWER_RESOURCE_URI,
  WINDOW_PRESET_NAMES,
  WINDOW_PRESETS,
} from "./shared/protocol.js";
import { injectBootstrap } from "./server/embed.js";
import { buildBootstrap, handleGetSlices, handleViewDicom } from "./server/tools.js";
import { SERVER_NAME, SERVER_VERSION } from "./server/version.js";

export { SERVER_NAME, SERVER_VERSION } from "./server/version.js";

const SELF_PATH = fileURLToPath(import.meta.url);
const SELF_DIR = path.dirname(SELF_PATH);

// Works both from source (server.ts) and compiled (dist/server.js)
const DIST_DIR = SELF_PATH.endsWith(".ts") ? path.join(SELF_DIR, "dist") : SELF_DIR;

export interface CreateServerOptions {
  /** Folder with the DICOM files. Relative paths resolve against process.cwd(). Default: ./dicom */
  dicomDir?: string;
  /** Embed the default series into the viewer HTML (hosts without the MCP Apps bridge). */
  embedSeries?: boolean;
  /** Override of the built viewer HTML (default: dist/mcp-app.html). Mainly for tests. */
  viewerHtmlPath?: string;
}

const presetList = WINDOW_PRESET_NAMES.map((name) => {
  const p = WINDOW_PRESETS[name];
  return `${name} (C${p.center}/W${p.width})`;
}).join(", ");

/**
 * Creates a new MCP server instance with tools and resources registered.
 * Cheap to call per request: scanned metadata and decoded pixels are cached
 * at module level.
 */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const dicomDir = path.resolve(options.dicomDir ?? "dicom");
  const embedSeries = options.embedSeries ?? false;
  const viewerHtmlPath = options.viewerHtmlPath ?? path.join(DIST_DIR, "mcp-app.html");

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerAppTool(
    server,
    VIEW_TOOL_NAME,
    {
      title: "View DICOM",
      description:
        "Open the DICOM series stored in the server's configured DICOM folder in an interactive viewer " +
        "(slice scrolling, window/level). Returns the list of series, metadata of the selected series " +
        "(no patient identifiers), files that could not be displayed and why, and a PNG of the middle " +
        "slice rendered with the chosen window so you can look at the images. Call without arguments " +
        "first; then pass seriesInstanceUid to switch series and a window to change contrast.",
      inputSchema: {
        seriesInstanceUid: z
          .string()
          .min(1)
          .optional()
          .describe(
            "SeriesInstanceUID to open, exactly as listed by a previous view-dicom result. " +
              "Omit to open the series with the most slices.",
          ),
        windowPreset: z
          .enum(WINDOW_PRESET_NAMES)
          .optional()
          .describe(
            `Named window in rescaled units (Hounsfield units for CT): ${presetList}. ` +
              "Omit to use the window stored in the files (or one derived from the pixel range).",
          ),
        windowCenter: z
          .number()
          .optional()
          .describe("Explicit window center (level) in rescaled units. Requires windowWidth; overrides windowPreset."),
        windowWidth: z
          .number()
          .min(1)
          .optional()
          .describe("Explicit window width (>= 1) in rescaled units. Requires windowCenter; overrides windowPreset."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: VIEWER_RESOURCE_URI } },
    },
    async (args): Promise<CallToolResult> => handleViewDicom(dicomDir, args),
  );

  registerAppTool(
    server,
    SLICES_TOOL_NAME,
    {
      title: "Get DICOM slices",
      description:
        "Viewer-internal: returns decoded pixel data (zlib-deflated, base64) for a range of slices of a series.",
      inputSchema: {
        seriesInstanceUid: z.string().min(1).describe("SeriesInstanceUID from a view-dicom result."),
        start: z.number().int().min(0).describe("Zero-based index of the first slice."),
        count: z
          .number()
          .int()
          .min(1)
          .max(MAX_SLICES_PER_REQUEST)
          .describe(`Number of slices (1-${MAX_SLICES_PER_REQUEST}); clamped to the series length.`),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: VIEWER_RESOURCE_URI, visibility: ["app"] } },
    },
    async (args): Promise<CallToolResult> => handleGetSlices(dicomDir, args),
  );

  registerAppResource(
    server,
    "DICOM Viewer",
    VIEWER_RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE, description: "Interactive DICOM series viewer" },
    async (): Promise<ReadResourceResult> => {
      let html: string;
      try {
        html = await fs.readFile(viewerHtmlPath, "utf-8");
      } catch {
        throw new Error(`Viewer UI not found at ${viewerHtmlPath}; run "npm run build" first.`);
      }

      if (embedSeries) {
        try {
          const bootstrap = await buildBootstrap(dicomDir);
          if (typeof bootstrap === "string") {
            console.error(`[dicom-viewer] --embed-series: nothing embedded: ${bootstrap}`);
          } else {
            html = injectBootstrap(html, bootstrap);
          }
        } catch (error) {
          console.error(`[dicom-viewer] --embed-series: failed to build payload: ${(error as Error).message}`);
        }
      }

      return {
        contents: [{ uri: VIEWER_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  return server;
}
