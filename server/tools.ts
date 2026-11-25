/**
 * Transport-independent implementations of the view-dicom and
 * get-dicom-slices tools (registered in ../server.ts).
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  WINDOW_PRESETS,
  type DicomBootstrap,
  type GetSlicesInput,
  type GetSlicesResult,
  type SeriesDetail,
  type ViewDicomInput,
  type ViewDicomResult,
  type WindowLevel,
} from "../shared/protocol.js";
import {
  DicomDirectoryError,
  findSeries,
  getDecodedSlices,
  getSeriesDetail,
  getSlicePixels,
  loadCatalog,
  middleSliceIndex,
  type Catalog,
  type SeriesEntry,
} from "./catalog.js";
import { renderKeyImage } from "./render.js";

const MAX_SKIPPED_IN_TEXT = 10;
const MAX_SERIES_IN_TEXT = 50;
const KEY_IMAGE_MAX_SIDE = 512;

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function structured<T extends object>(value: T): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function seriesLine(entry: SeriesEntry): string {
  const s = entry.summary;
  const parts = [
    s.seriesDescription ? `"${s.seriesDescription}"` : "(no description)",
    s.modality ?? "unknown modality",
    `${s.sliceCount} slice${s.sliceCount === 1 ? "" : "s"}`,
    `${s.columns}x${s.rows} px`,
  ];
  return `${s.seriesInstanceUid} — ${parts.join(", ")}`;
}

function skippedLines(catalog: Catalog): string[] {
  const lines = catalog.skipped.slice(0, MAX_SKIPPED_IN_TEXT).map((s) => `- ${s.filename}: ${s.reason}`);
  if (catalog.skipped.length > MAX_SKIPPED_IN_TEXT) {
    lines.push(`- …and ${catalog.skipped.length - MAX_SKIPPED_IN_TEXT} more`);
  }
  return lines;
}

async function loadOrError(directory: string): Promise<Catalog | CallToolResult> {
  try {
    return await loadCatalog(directory);
  } catch (error) {
    if (error instanceof DicomDirectoryError) {
      return errorResult(
        `${error.message}\nCreate it and copy a DICOM series into it, or restart the server with ` +
          `--dir <path> (or the DICOM_DIR environment variable) pointing at a folder of .dcm files.`,
      );
    }
    return errorResult(`Failed to scan the DICOM directory ${directory}: ${(error as Error).message}`);
  }
}

function catalogProblem(catalog: Catalog): CallToolResult | undefined {
  if (catalog.fileCount === 0) {
    return errorResult(
      `No DICOM files found in ${catalog.directory}. The server reads *.dcm files (any case) and ` +
        `extension-less files with the DICM signature, non-recursively. Copy a series there or ` +
        `restart the server with --dir <path> / DICOM_DIR.`,
    );
  }
  if (catalog.series.length === 0) {
    return errorResult(
      [
        `None of the ${catalog.fileCount} DICOM file(s) in ${catalog.directory} can be displayed. ` +
          `This viewer decodes uncompressed pixel data only (Implicit/Explicit VR Little Endian, ` +
          `Deflated, Explicit VR Big Endian); convert compressed files first, e.g. with ` +
          `"dcmdjpeg"/"gdcmconv --raw".`,
        "Skipped files:",
        ...skippedLines(catalog),
      ].join("\n"),
    );
  }
  return undefined;
}

type WindowChoice = { window: WindowLevel; source: string };

function chooseWindow(input: ViewDicomInput, detail: SeriesDetail): WindowChoice | CallToolResult {
  const hasCenter = input.windowCenter !== undefined;
  const hasWidth = input.windowWidth !== undefined;
  if (hasCenter !== hasWidth) {
    return errorResult(
      "windowCenter and windowWidth must be given together (or use windowPreset: " +
        `${Object.keys(WINDOW_PRESETS).join(", ")}).`,
    );
  }
  if (hasCenter && hasWidth) {
    return { window: { center: input.windowCenter!, width: Math.max(1, input.windowWidth!) }, source: "explicit" };
  }
  if (input.windowPreset) {
    const preset = WINDOW_PRESETS[input.windowPreset];
    return { window: { center: preset.center, width: preset.width }, source: `preset "${input.windowPreset}"` };
  }
  return { window: { ...detail.defaultWindow }, source: "series default" };
}

/** Builds the structured view result (shared by view-dicom and embed mode). */
export async function buildView(
  catalog: Catalog,
  entry: SeriesEntry,
  input: ViewDicomInput,
): Promise<{ result: ViewDicomResult; windowSource: string } | CallToolResult> {
  const detail = await getSeriesDetail(entry);
  const choice = chooseWindow(input, detail);
  if ("content" in choice) return choice;
  return {
    result: {
      series: catalog.series.map((s) => ({ ...s.summary })),
      selected: detail,
      window: choice.window,
      skipped: catalog.skipped.map((s) => ({ ...s })),
    },
    windowSource: choice.source,
  };
}

function selectSeries(catalog: Catalog, uid: string | undefined): SeriesEntry | CallToolResult {
  if (uid === undefined) return catalog.defaultSeries!;
  const entry = findSeries(catalog, uid);
  if (entry) return entry;
  const list = catalog.series.slice(0, MAX_SERIES_IN_TEXT).map((s) => `- ${seriesLine(s)}`);
  if (catalog.series.length > MAX_SERIES_IN_TEXT) {
    list.push(`- …and ${catalog.series.length - MAX_SERIES_IN_TEXT} more`);
  }
  return errorResult([`Unknown seriesInstanceUid "${uid}". Valid values:`, ...list].join("\n"));
}

function summaryText(
  catalog: Catalog,
  entry: SeriesEntry,
  view: ViewDicomResult,
  windowSource: string,
  keyImage: string,
): string {
  const { selected, window } = view;
  const totalSlices = catalog.series.reduce((n, s) => n + s.summary.sliceCount, 0);
  const lines: string[] = [
    `DICOM directory ${catalog.directory}: ${catalog.series.length} series, ${totalSlices} displayable slice(s)` +
      (catalog.skipped.length ? `, ${catalog.skipped.length} file(s) skipped.` : "."),
    "",
    "Series:",
  ];
  for (const s of catalog.series.slice(0, MAX_SERIES_IN_TEXT)) {
    lines.push(`- ${seriesLine(s)}${s === entry ? "  [selected]" : ""}`);
  }
  if (catalog.series.length > MAX_SERIES_IN_TEXT) {
    lines.push(`- …and ${catalog.series.length - MAX_SERIES_IN_TEXT} more`);
  }

  lines.push(
    "",
    `Selected series: ${selected.seriesInstanceUid}` +
      (selected.seriesDescription ? ` ("${selected.seriesDescription}")` : "") +
      (selected.studyDescription ? `, study "${selected.studyDescription}"` : ""),
    `- ${selected.sliceCount} slice(s), ${selected.columns}x${selected.rows} px, ` +
      `${selected.photometricInterpretation}, ${selected.bitsStored} bits stored (${selected.pixelFormat})`,
  );
  if (selected.pixelSpacing) {
    lines.push(
      `- Pixel spacing: ${fmt(selected.pixelSpacing[0])} x ${fmt(selected.pixelSpacing[1])} mm (row x column)` +
        (selected.sliceThickness !== undefined ? `; slice thickness ${fmt(selected.sliceThickness)} mm` : ""),
    );
  } else if (selected.sliceThickness !== undefined) {
    lines.push(`- Slice thickness ${fmt(selected.sliceThickness)} mm; pixel spacing unknown`);
  } else {
    lines.push("- Pixel spacing unknown");
  }
  lines.push(
    `- Window: center ${fmt(window.center)}, width ${fmt(window.width)} (${windowSource}); ` +
      `series default center ${fmt(selected.defaultWindow.center)}, width ${fmt(selected.defaultWindow.width)}`,
    `- ${keyImage}`,
  );

  if (catalog.skipped.length) {
    lines.push("", `Skipped files (${catalog.skipped.length}):`, ...skippedLines(catalog));
  }
  lines.push(
    "",
    "The interactive viewer (scroll through slices, adjust window/level) is attached to this result " +
      "in hosts that support MCP Apps. Call view-dicom again with seriesInstanceUid, windowPreset, or " +
      "windowCenter+windowWidth to change what is shown.",
  );
  return lines.join("\n");
}

export async function handleViewDicom(directory: string, input: ViewDicomInput): Promise<CallToolResult> {
  const loaded = await loadOrError(directory);
  if ("content" in loaded) return loaded;
  const catalog = loaded;
  const problem = catalogProblem(catalog);
  if (problem) return problem;

  const entry = selectSeries(catalog, input.seriesInstanceUid);
  if ("content" in entry) return entry;

  let built;
  try {
    built = await buildView(catalog, entry, input);
  } catch (error) {
    return errorResult(`Failed to read series ${entry.summary.seriesInstanceUid}: ${(error as Error).message}`);
  }
  if ("content" in built) return built;
  const { result, windowSource } = built;

  let imageBlock: CallToolResult["content"][number] | undefined;
  let keyImageText: string;
  const middle = middleSliceIndex(entry);
  try {
    const [frame] = await getDecodedSlices(entry, [middle]);
    const slice = entry.slices[middle];
    const image = renderKeyImage(frame, {
      window: result.window,
      rescaleSlope: slice.rescaleSlope,
      rescaleIntercept: slice.rescaleIntercept,
      invert: slice.instance.layout.photometric === "MONOCHROME1",
      pixelSpacing: result.selected.pixelSpacing,
      maxSide: KEY_IMAGE_MAX_SIDE,
    });
    keyImageText =
      `Attached image: middle slice (index ${middle} of ${entry.slices.length}) rendered with this window, ` +
      `${image.width}x${image.height} px.`;
    imageBlock = { type: "image", data: image.png.toString("base64"), mimeType: "image/png" };
  } catch (error) {
    keyImageText = `Key image unavailable: ${(error as Error).message}`;
  }

  const text = summaryText(catalog, entry, result, windowSource, keyImageText);
  const content: CallToolResult["content"] = [{ type: "text", text }];
  if (imageBlock) content.push(imageBlock);
  return { content, structuredContent: structured(result) };
}

export async function handleGetSlices(directory: string, input: GetSlicesInput): Promise<CallToolResult> {
  const loaded = await loadOrError(directory);
  if ("content" in loaded) return loaded;
  const entry = findSeries(loaded, input.seriesInstanceUid);
  if (!entry) {
    return errorResult(
      `Unknown seriesInstanceUid "${input.seriesInstanceUid}" (the directory may have changed; call view-dicom again).`,
    );
  }
  const total = entry.slices.length;
  if (input.start >= total) {
    return errorResult(`start ${input.start} is out of range; series has ${total} slice(s) (0..${total - 1}).`);
  }
  let slices;
  try {
    slices = await getSlicePixels(entry, input.start, input.count);
  } catch (error) {
    return errorResult(`Failed to read slices: ${(error as Error).message}`);
  }
  const result: GetSlicesResult = { seriesInstanceUid: entry.summary.seriesInstanceUid, slices };
  const last = input.start + slices.length - 1;
  return {
    content: [{ type: "text", text: `Slices ${input.start}-${last} of ${total} (${slices.length} returned).` }],
    structuredContent: structured(result),
  };
}

/**
 * Bootstrap payload for embed mode: the default series, default window and
 * every slice. Returns an error message instead when nothing can be shown.
 */
export async function buildBootstrap(directory: string): Promise<DicomBootstrap | string> {
  const loaded = await loadOrError(directory);
  if ("content" in loaded) return textOf(loaded);
  const problem = catalogProblem(loaded);
  if (problem) return textOf(problem);
  const entry = loaded.defaultSeries!;
  const built = await buildView(loaded, entry, {});
  if ("content" in built) return textOf(built);
  const slices = await getSlicePixels(entry, 0, entry.slices.length);
  return { view: built.result, slices };
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}
