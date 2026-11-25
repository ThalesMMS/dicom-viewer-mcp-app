import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BOOTSTRAP_GLOBAL,
  MAX_SLICES_PER_REQUEST,
  SLICES_TOOL_NAME,
  VIEW_TOOL_NAME,
  VIEWER_RESOURCE_URI,
  type DicomBootstrap,
  type GetSlicesResult,
  type ViewDicomResult,
} from "../shared/protocol.js";
import { createServer, type CreateServerOptions } from "../server.js";
import { clearDicomCaches } from "../server/catalog.js";
import { buildDicom, PATIENT_ID, PATIENT_NAME, TS, type SyntheticImage } from "./helpers/dicom-writer.js";
import { decodePng } from "./helpers/png-decode.js";
import { makeTempDir, removeDir } from "./helpers/tmp.js";

const SERIES = "1.2.826.0.1.3680043.99.7";
const SLICES = 11;
const ROWS = 64;
const COLUMNS = 48;
const HTML = "<!DOCTYPE html><html><head><title>Viewer</title></head><body><div id=root></div></body></html>";

function ctSlice(i: number): SyntheticImage {
  const samples: number[] = [];
  for (let p = 0; p < ROWS * COLUMNS; p++) samples.push(((p + i * 37) % 2000) - 1000);
  return {
    rows: ROWS,
    columns: COLUMNS,
    pixelRepresentation: 1,
    samples,
    seriesInstanceUid: SERIES,
    seriesNumber: 2,
    seriesDescription: "Synthetic CT </script>",
    studyDescription: "Phantom study",
    modality: "CT",
    instanceNumber: SLICES - i,
    imagePositionPatient: [0, 0, i * 2.5],
    imageOrientationPatient: [1, 0, 0, 0, 1, 0],
    pixelSpacing: [0.7, 0.7],
    sliceThickness: 2.5,
    rescaleSlope: 1,
    rescaleIntercept: -24,
    windowCenter: [40, 300],
    windowWidth: [400, 1500],
  };
}

let dir: string;
let htmlPath: string;
const collected: unknown[] = [];

async function connect(options: Partial<CreateServerOptions> = {}): Promise<Client> {
  const server = createServer({ dicomDir: dir, viewerHtmlPath: htmlPath, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  collected.push(result);
  return result;
}

function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

beforeAll(() => {
  const files: Record<string, Uint8Array | string> = {};
  // Shuffled file names vs. geometric order.
  const order = [7, 2, 10, 0, 5, 9, 1, 4, 8, 3, 6];
  order.forEach((i, n) => (files[`img${String(n).padStart(2, "0")}.dcm`] = buildDicom(ctSlice(i))));
  files["scout.dcm"] = buildDicom({
    rows: 4,
    columns: 4,
    bitsAllocated: 8,
    samplesPerPixel: 3,
    photometric: "RGB",
    samples: new Array(48).fill(200),
    seriesInstanceUid: "1.2.826.0.1.3680043.99.8",
    seriesNumber: 1,
    seriesDescription: "Color scout",
    modality: "OT",
  });
  files["compressed.dcm"] = buildDicom({ ...ctSlice(0), transferSyntax: TS.jpegBaseline });
  dir = makeTempDir(files);
  htmlPath = path.join(dir, "viewer.html");
  fs.writeFileSync(htmlPath, HTML);
});

afterAll(() => removeDir(dir));
beforeEach(() => clearDicomCaches());

describe("MCP integration (in-memory transport)", () => {
  it("lists both tools with the right visibility and schema", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const view = tools.find((t) => t.name === VIEW_TOOL_NAME)!;
    const slices = tools.find((t) => t.name === SLICES_TOOL_NAME)!;
    expect(view._meta?.ui).toEqual({ resourceUri: VIEWER_RESOURCE_URI });
    expect(slices._meta?.ui).toEqual({ resourceUri: VIEWER_RESOURCE_URI, visibility: ["app"] });
    expect(Object.keys(view.inputSchema.properties ?? {}).sort()).toEqual([
      "seriesInstanceUid",
      "windowCenter",
      "windowPreset",
      "windowWidth",
    ]);
    expect(slices.inputSchema.required?.sort()).toEqual(["count", "seriesInstanceUid", "start"]);
  });

  it("view-dicom returns structured content, a summary and a key image", async () => {
    const client = await connect();
    const result = await call(client, VIEW_TOOL_NAME, {});
    expect(result.isError).toBeFalsy();
    const view = result.structuredContent as unknown as ViewDicomResult;

    expect(view.series.map((s) => s.seriesInstanceUid)).toEqual(["1.2.826.0.1.3680043.99.8", SERIES]);
    expect(view.selected.seriesInstanceUid).toBe(SERIES);
    expect(view.selected.sliceCount).toBe(SLICES);
    expect(view.selected.pixelFormat).toBe("int16");
    expect(view.selected.pixelSpacing).toEqual([0.7, 0.7]);
    expect(view.selected.defaultWindow).toEqual({ center: 40, width: 400 });
    expect(view.window).toEqual({ center: 40, width: 400 });
    expect(view.selected.slices.map((s) => s.imagePositionPatient?.[2])).toEqual(
      Array.from({ length: SLICES }, (_, i) => i * 2.5),
    );
    expect(view.skipped).toEqual([
      { filename: "compressed.dcm", reason: "Unsupported transfer syntax: JPEG Baseline (Process 1) (1.2.840.10008.1.2.4.50)" },
    ]);

    const summary = text(result);
    expect(summary).toContain(SERIES);
    expect(summary).toContain("[selected]");
    expect(summary).toContain("Pixel spacing: 0.7 x 0.7 mm");
    expect(summary).toContain("compressed.dcm: Unsupported transfer syntax");

    const image = result.content.find((c) => c.type === "image");
    expect(image?.type === "image" && image.mimeType).toBe("image/png");
    const png = decodePng(Buffer.from(image?.type === "image" ? image.data : "", "base64"));
    expect([png.width, png.height]).toEqual([COLUMNS, ROWS]);
    expect(png.chunks.every((c) => c.crcOk)).toBe(true);
  });

  it("applies presets and explicit windows, and validates them", async () => {
    const client = await connect();
    const lung = await call(client, VIEW_TOOL_NAME, { windowPreset: "lung" });
    expect((lung.structuredContent as unknown as ViewDicomResult).window).toEqual({ center: -600, width: 1500 });

    const explicit = await call(client, VIEW_TOOL_NAME, { windowPreset: "lung", windowCenter: 10, windowWidth: 20 });
    expect((explicit.structuredContent as unknown as ViewDicomResult).window).toEqual({ center: 10, width: 20 });

    const half = await call(client, VIEW_TOOL_NAME, { windowCenter: 10 });
    expect(half.isError).toBe(true);
    expect(text(half)).toMatch(/must be given together/);
  });

  it("selects a series by UID and lists valid UIDs for an unknown one", async () => {
    const client = await connect();
    const scout = await call(client, VIEW_TOOL_NAME, { seriesInstanceUid: "1.2.826.0.1.3680043.99.8" });
    const view = scout.structuredContent as unknown as ViewDicomResult;
    expect(view.selected.pixelFormat).toBe("rgb8");
    const png = decodePng(Buffer.from((scout.content[1] as { data: string }).data, "base64"));
    expect(png.colorType).toBe(2);
    expect(png.pixels[0]).toBe(200);

    const unknown = await call(client, VIEW_TOOL_NAME, { seriesInstanceUid: "9.9.9" });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain('Unknown seriesInstanceUid "9.9.9"');
    expect(text(unknown)).toContain(SERIES);
  });

  it("get-dicom-slices returns deflated little-endian samples that round-trip", async () => {
    const client = await connect();
    const result = await call(client, SLICES_TOOL_NAME, { seriesInstanceUid: SERIES, start: 9, count: MAX_SLICES_PER_REQUEST });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as unknown as GetSlicesResult;
    expect(payload.seriesInstanceUid).toBe(SERIES);
    expect(payload.slices.map((s) => s.index)).toEqual([9, 10]); // clamped to the series length

    for (const slice of payload.slices) {
      expect(slice).toMatchObject({ rows: ROWS, columns: COLUMNS, pixelFormat: "int16", rescaleSlope: 1, rescaleIntercept: -24, invert: false });
      const bytes = zlib.inflateSync(Buffer.from(slice.data, "base64"));
      const values = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      const expected = ctSlice(slice.index).samples!;
      expect(values.length).toBe(expected.length);
      expect(Array.from(values)).toEqual(expected);
    }
  });

  it("get-dicom-slices rejects bad arguments", async () => {
    const client = await connect();
    const outOfRange = await call(client, SLICES_TOOL_NAME, { seriesInstanceUid: SERIES, start: 50, count: 1 });
    expect(outOfRange.isError).toBe(true);
    const unknown = await call(client, SLICES_TOOL_NAME, { seriesInstanceUid: "nope", start: 0, count: 1 });
    expect(unknown.isError).toBe(true);

    const tooMany = await client
      .callTool({ name: SLICES_TOOL_NAME, arguments: { seriesInstanceUid: SERIES, start: 0, count: MAX_SLICES_PER_REQUEST + 1 } })
      .then((r) => r as CallToolResult, (e: Error) => ({ isError: true, content: [{ type: "text" as const, text: e.message }] }));
    expect(tooMany.isError).toBe(true);
  });

  it("serves the static HTML untouched without --embed-series", async () => {
    const client = await connect();
    const resource = await client.readResource({ uri: VIEWER_RESOURCE_URI });
    const content = resource.contents[0] as { text: string; mimeType: string };
    expect(content.text).toBe(HTML);
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    collected.push(resource);
  });

  it("embeds the default series with --embed-series", async () => {
    const client = await connect({ embedSeries: true });
    const resource = await client.readResource({ uri: VIEWER_RESOURCE_URI });
    const html = (resource.contents[0] as { text: string }).text;
    collected.push(resource);
    expect(html).toContain(`window.${BOOTSTRAP_GLOBAL} = `);
    // The "</script>" inside the series description is escaped.
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    const json = html.slice(html.indexOf("= ") + 2, html.indexOf(";</script>"));
    const bootstrap = JSON.parse(json) as DicomBootstrap;
    expect(bootstrap.view.selected.seriesInstanceUid).toBe(SERIES);
    expect(bootstrap.view.selected.seriesDescription).toBe("Synthetic CT </script>");
    expect(bootstrap.slices).toHaveLength(SLICES);
  });

  it("returns actionable errors for a missing or empty directory", async () => {
    const missing = await connect({ dicomDir: path.join(dir, "does-not-exist") });
    const r1 = await call(missing, VIEW_TOOL_NAME, {});
    expect(r1.isError).toBe(true);
    expect(text(r1)).toMatch(/DICOM directory not found.*--dir/s);

    const emptyDir = makeTempDir({ "notes.txt": "x" });
    try {
      const empty = await connect({ dicomDir: emptyDir });
      const r2 = await call(empty, VIEW_TOOL_NAME, {});
      expect(r2.isError).toBe(true);
      expect(text(r2)).toMatch(/No DICOM files found/);
    } finally {
      removeDir(emptyDir);
    }

    const onlyCompressed = makeTempDir({ "a.dcm": buildDicom({ ...ctSlice(0), transferSyntax: TS.jpeg2000 }) });
    try {
      const client = await connect({ dicomDir: onlyCompressed });
      const r3 = await call(client, VIEW_TOOL_NAME, {});
      expect(r3.isError).toBe(true);
      expect(text(r3)).toMatch(/can be displayed[\s\S]*a\.dcm: Unsupported transfer syntax: JPEG 2000/);
    } finally {
      removeDir(onlyCompressed);
    }
  });

  it("never exposes patient identifiers", () => {
    expect(collected.length).toBeGreaterThan(5);
    const everything = JSON.stringify(collected);
    expect(everything).not.toContain(PATIENT_NAME);
    expect(everything).not.toContain("TESTPATIENT");
    expect(everything).not.toContain(PATIENT_ID);
    expect(everything).not.toContain("19700101");
  });
});
