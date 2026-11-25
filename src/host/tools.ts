/**
 * @file Server tool calls made by the UI and interpretation of their results.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import {
  MAX_SLICES_PER_REQUEST,
  SLICES_TOOL_NAME,
  VIEW_TOOL_NAME,
  type DicomBootstrap,
  type GetSlicesInput,
  type SlicePixels,
  type ViewDicomInput,
  type ViewDicomResult,
} from "../../shared/protocol";
import type { FetchSlices } from "../hooks/useSliceLoader";
import { parseGetSlicesResult, parseViewDicomResult, resultText } from "../viewer/validate";

interface ToolResultLike {
  structuredContent?: unknown;
  isError?: boolean;
  content?: unknown;
}

export type ViewOutcome = { ok: true; view: ViewDicomResult } | { ok: false; error: string };

/** Interprets a view-dicom result (from ontoolresult or callServerTool). */
export function interpretViewResult(result: ToolResultLike): ViewOutcome {
  if (result.isError) {
    return { ok: false, error: resultText(result) || "The view-dicom tool reported an error." };
  }
  const view = parseViewDicomResult(result.structuredContent);
  if (!view) {
    const text = resultText(result);
    return {
      ok: false,
      error: text
        ? `The tool result did not contain viewer data. Server said: ${text}`
        : "The tool result did not contain viewer data.",
    };
  }
  if (view.selected.slices.length === 0) {
    return { ok: false, error: "The selected series has no displayable slices." };
  }
  return { ok: true, view };
}

export async function callViewDicom(app: App, input: ViewDicomInput): Promise<ViewDicomResult> {
  const result = await app.callServerTool({ name: VIEW_TOOL_NAME, arguments: { ...input } });
  const outcome = interpretViewResult(result);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.view;
}

export async function callGetSlices(app: App, input: GetSlicesInput): Promise<SlicePixels[]> {
  const args: GetSlicesInput = {
    seriesInstanceUid: input.seriesInstanceUid,
    start: input.start,
    count: Math.max(1, Math.min(MAX_SLICES_PER_REQUEST, input.count)),
  };
  const result = await app.callServerTool({ name: SLICES_TOOL_NAME, arguments: { ...args } });
  if (result.isError) {
    throw new Error(resultText(result) || "The server could not provide the pixel data.");
  }
  const parsed = parseGetSlicesResult(result.structuredContent);
  if (!parsed) throw new Error("Malformed pixel data response.");
  if (parsed.seriesInstanceUid !== input.seriesInstanceUid) {
    throw new Error("Pixel data belongs to a different series.");
  }
  return parsed.slices;
}

export function bridgeFetcher(app: App): FetchSlices {
  return (seriesInstanceUid, start, count) => callGetSlices(app, { seriesInstanceUid, start, count });
}

/** Serves slices from the payload embedded in the page. */
export function bootstrapFetcher(bootstrap: DicomBootstrap): FetchSlices {
  const byIndex = new Map(bootstrap.slices.map((s) => [s.index, s]));
  return async (seriesInstanceUid, start, count) => {
    if (seriesInstanceUid !== bootstrap.view.selected.seriesInstanceUid) return [];
    const out: SlicePixels[] = [];
    for (let i = start; i < start + count; i++) {
      const s = byIndex.get(i);
      if (s) out.push(s);
    }
    return out;
  };
}
