/**
 * Directory scanning, caching, series grouping/sorting and pixel access.
 *
 * Caches are module-level so that repeated tool calls and the stateless HTTP
 * transport (a new McpServer per request) share parsed metadata:
 * - parsed metadata per file, keyed by path + size + mtime (never pixel data);
 * - the grouped catalog per directory, keyed by the directory listing signature;
 * - decoded frames in a byte-bounded LRU.
 */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import type {
  SeriesDetail,
  SeriesSummary,
  SkippedFile,
  SliceMeta,
  SlicePixels,
  WindowLevel,
} from "../shared/protocol.js";
import {
  decodeFrame,
  frameToLittleEndianBytes,
  hasDicmMagic,
  isPadding,
  parseInstance,
  readFrameBytes,
  type DecodedFrame,
  type FileIdentity,
  type InstanceInfo,
  type ParseOutcome,
  type Vec3,
} from "./dicom.js";
import { ByteBudgetLru, mapWithConcurrency } from "./lru.js";

const READ_CONCURRENCY = 8;
/** Files larger than this are parsed from a head read first. */
const PARTIAL_READ_THRESHOLD = 4 * 1024 * 1024;
const HEAD_BYTES = 1024 * 1024;
const DECODED_FRAME_BUDGET = 256 * 1024 * 1024;

export class DicomDirectoryError extends Error {
  constructor(
    message: string,
    readonly directory: string,
  ) {
    super(message);
    this.name = "DicomDirectoryError";
  }
}

export interface SliceRef {
  instance: InstanceInfo;
  frame: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  meta: SliceMeta;
}

export interface SeriesEntry {
  summary: SeriesSummary;
  /** Sorted, displayable slices (frames expanded). */
  slices: SliceRef[];
  instances: InstanceInfo[];
  seriesNumber?: number;
  detail?: Promise<SeriesDetail>;
}

export interface Catalog {
  directory: string;
  /** Number of candidate files found (displayable or not). */
  fileCount: number;
  /** Ordered by SeriesNumber, then description, then UID. */
  series: SeriesEntry[];
  skipped: SkippedFile[];
  /** Series with the most slices (ties: first in `series` order). */
  defaultSeries?: SeriesEntry;
}

interface CandidateFile extends FileIdentity {
  /** Needs a DICM magic check (extensionless file). */
  needsMagic: boolean;
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

const parseCache = new Map<string, { size: number; mtimeMs: number; outcome: ParseOutcome }>();
const magicCache = new Map<string, { size: number; mtimeMs: number; isDicom: boolean }>();
const catalogCache = new Map<string, { signature: string; promise: Promise<Catalog> }>();
const frameCache = new ByteBudgetLru<string, DecodedFrame>(
  DECODED_FRAME_BUDGET,
  (frame) => frame.samples.byteLength,
);

/** Clears every module-level cache (used by tests). */
export function clearDicomCaches(): void {
  parseCache.clear();
  magicCache.clear();
  catalogCache.clear();
  frameCache.clear();
}

/** Introspection for tests and diagnostics. */
export function cacheStats(): { parsedFiles: number; decodedFrames: number; decodedBytes: number } {
  return { parsedFiles: parseCache.size, decodedFrames: frameCache.size, decodedBytes: frameCache.totalCost };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

async function listCandidates(directory: string): Promise<CandidateFile[]> {
  let stat;
  try {
    stat = await fs.stat(directory);
  } catch {
    throw new DicomDirectoryError(`DICOM directory not found: ${directory}`, directory);
  }
  if (!stat.isDirectory()) {
    throw new DicomDirectoryError(`DICOM path is not a directory: ${directory}`, directory);
  }

  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new DicomDirectoryError(
      `Cannot read DICOM directory ${directory}: ${(error as Error).message}`,
      directory,
    );
  }

  const names = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => {
      const ext = path.extname(name);
      return ext === "" || ext.toLowerCase() === ".dcm";
    })
    .sort();

  const stats = await mapWithConcurrency(names, 32, async (name) => {
    const filePath = path.join(directory, name);
    try {
      const s = await fs.stat(filePath);
      if (!s.isFile()) return undefined;
      return {
        filename: name,
        filePath,
        size: s.size,
        mtimeMs: s.mtimeMs,
        needsMagic: path.extname(name) === "",
      } satisfies CandidateFile;
    } catch {
      return undefined;
    }
  });
  return stats.filter((s): s is CandidateFile => s !== undefined);
}

async function hasMagic(file: CandidateFile): Promise<boolean> {
  const cached = magicCache.get(file.filePath);
  if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) return cached.isDicom;
  let isDicom = false;
  if (file.size >= 132) {
    const handle = await fs.open(file.filePath, "r");
    try {
      const head = new Uint8Array(132);
      const { bytesRead } = await handle.read(head, 0, 132, 0);
      isDicom = bytesRead === 132 && hasDicmMagic(head);
    } finally {
      await handle.close();
    }
  }
  magicCache.set(file.filePath, { size: file.size, mtimeMs: file.mtimeMs, isDicom });
  return isDicom;
}

async function readHead(filePath: string, length: number): Promise<Uint8Array> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

async function parseFile(file: CandidateFile): Promise<ParseOutcome> {
  const cached = parseCache.get(file.filePath);
  if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) return cached.outcome;

  let outcome: ParseOutcome;
  try {
    let result: ParseOutcome | "need-full-file" = "need-full-file";
    if (file.size > PARTIAL_READ_THRESHOLD) {
      result = parseInstance(await readHead(file.filePath, HEAD_BYTES), file, true);
    }
    if (result === "need-full-file") {
      const bytes = await fs.readFile(file.filePath);
      result = parseInstance(bytes, file, false);
      if (result === "need-full-file") {
        result = { ok: false, reason: "Could not locate Pixel Data" };
      }
    }
    outcome = result;
  } catch (error) {
    outcome = { ok: false, reason: `Could not read file: ${(error as Error).message}` };
  }
  parseCache.set(file.filePath, { size: file.size, mtimeMs: file.mtimeMs, outcome });
  return outcome;
}

/**
 * Scans `directory` (non-recursively) and returns the grouped catalog.
 * Results are cached; the directory listing is re-stat'ed on every call so
 * added, removed or modified files are picked up.
 */
export async function loadCatalog(directory: string): Promise<Catalog> {
  const absolute = path.resolve(directory);
  const candidates = await listCandidates(absolute);
  const signature = candidates.map((f) => `${f.filename}\0${f.size}\0${f.mtimeMs}`).join("\n");
  const cached = catalogCache.get(absolute);
  if (cached && cached.signature === signature) return cached.promise;

  const promise = buildCatalog(absolute, candidates);
  catalogCache.set(absolute, { signature, promise });
  promise.catch(() => {
    if (catalogCache.get(absolute)?.promise === promise) catalogCache.delete(absolute);
  });
  return promise;
}

async function buildCatalog(directory: string, candidates: CandidateFile[]): Promise<Catalog> {
  // Forget cached entries of files that disappeared from this directory.
  const present = new Set(candidates.map((c) => c.filePath));
  for (const cache of [parseCache, magicCache]) {
    for (const key of cache.keys()) {
      if (path.dirname(key) === directory && !present.has(key)) cache.delete(key);
    }
  }

  const magic = await mapWithConcurrency(candidates, READ_CONCURRENCY, async (file) =>
    file.needsMagic ? hasMagic(file).catch(() => false) : true,
  );
  const files = candidates.filter((_, i) => magic[i]);
  const outcomes = await mapWithConcurrency(files, READ_CONCURRENCY, parseFile);

  const skipped: SkippedFile[] = [];
  const instances: InstanceInfo[] = [];
  outcomes.forEach((outcome, i) => {
    if (outcome.ok) instances.push(outcome.info);
    else skipped.push({ filename: files[i].filename, reason: outcome.reason });
  });

  const series = groupSeries(instances, skipped);
  skipped.sort((a, b) => a.filename.localeCompare(b.filename));

  let defaultSeries: SeriesEntry | undefined;
  for (const entry of series) {
    if (!defaultSeries || entry.summary.sliceCount > defaultSeries.summary.sliceCount) defaultSeries = entry;
  }
  return { directory, fileCount: files.length, series, skipped, defaultSeries };
}

// ---------------------------------------------------------------------------
// Grouping and sorting
// ---------------------------------------------------------------------------

function syntheticSeriesUid(info: InstanceInfo): string {
  const key = [
    info.studyInstanceUid ?? "",
    info.seriesNumber ?? "",
    info.seriesDescription ?? "",
    info.modality ?? "",
  ].join("|");
  return `synthetic-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function cross(a: number[], b: number[]): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** All instances have a position and the same orientation (within tolerance). */
export function hasConsistentOrientation(instances: readonly InstanceInfo[], tolerance = 1e-4): boolean {
  if (instances.length === 0) return false;
  const reference = instances[0].imageOrientationPatient;
  if (!reference || reference.length < 6) return false;
  return instances.every(
    (inst) =>
      inst.imagePositionPatient !== undefined &&
      inst.imageOrientationPatient !== undefined &&
      inst.imageOrientationPatient.length >= 6 &&
      reference.every((v, i) => Math.abs(v - inst.imageOrientationPatient![i]) <= tolerance),
  );
}

/** Position of the slice along the normal of its orientation. */
export function sliceCoordinate(position: readonly number[], orientation: readonly number[]): number {
  return dot(position, cross(orientation.slice(0, 3), orientation.slice(3, 6)));
}

function allDefined<T>(items: readonly InstanceInfo[], pick: (i: InstanceInfo) => T | undefined): boolean {
  return items.every((item) => pick(item) !== undefined);
}

/**
 * Sorts instances of one series: geometric when orientation is consistent,
 * else by InstanceNumber, else SliceLocation, else filename.
 */
export function sortInstances(instances: readonly InstanceInfo[]): InstanceInfo[] {
  const byName = (a: InstanceInfo, b: InstanceInfo) => a.filename.localeCompare(b.filename);
  const tie = (a: InstanceInfo, b: InstanceInfo) =>
    (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0) || byName(a, b);
  const list = instances.slice();

  if (hasConsistentOrientation(list)) {
    const orientation = list[0].imageOrientationPatient!;
    const key = new Map(list.map((i) => [i, sliceCoordinate(i.imagePositionPatient!, orientation)]));
    return list.sort((a, b) => key.get(a)! - key.get(b)! || tie(a, b));
  }
  if (allDefined(list, (i) => i.instanceNumber)) {
    return list.sort((a, b) => a.instanceNumber! - b.instanceNumber! || byName(a, b));
  }
  if (allDefined(list, (i) => i.sliceLocation)) {
    return list.sort((a, b) => a.sliceLocation! - b.sliceLocation! || tie(a, b));
  }
  return list.sort(byName);
}

function formatKey(info: InstanceInfo): string {
  return `${info.layout.rows}x${info.layout.columns}|${info.layout.pixelFormat}`;
}

function groupSeries(instances: InstanceInfo[], skipped: SkippedFile[]): SeriesEntry[] {
  const groups = new Map<string, InstanceInfo[]>();
  for (const info of instances) {
    const uid = info.seriesInstanceUid ?? syntheticSeriesUid(info);
    const list = groups.get(uid);
    if (list) list.push(info);
    else groups.set(uid, [info]);
  }

  const entries: SeriesEntry[] = [];
  for (const [uid, all] of groups) {
    // Keep the dominant size/format; a series' slices must share them.
    const byFormat = new Map<string, InstanceInfo[]>();
    for (const info of all) {
      const key = formatKey(info);
      const list = byFormat.get(key);
      if (list) list.push(info);
      else byFormat.set(key, [info]);
    }
    let keep: InstanceInfo[] = [];
    let keepKey = "";
    for (const [key, list] of byFormat) {
      if (list.length > keep.length) {
        keep = list;
        keepKey = key;
      }
    }
    for (const [key, list] of byFormat) {
      if (key === keepKey) continue;
      for (const info of list) {
        const [dims, format] = key.split("|");
        const [keepDims, keepFormat] = keepKey.split("|");
        skipped.push({
          filename: info.filename,
          reason: `Image size/format ${dims} ${format} differs from the rest of series ${uid} (${keepDims} ${keepFormat})`,
        });
      }
    }

    // Drop duplicate SOP instances (same object stored twice).
    const seen = new Map<string, string>();
    const unique: InstanceInfo[] = [];
    for (const info of keep.slice().sort((a, b) => a.filename.localeCompare(b.filename))) {
      const sop = info.sopInstanceUid;
      if (sop && seen.has(sop)) {
        skipped.push({ filename: info.filename, reason: `Duplicate of ${seen.get(sop)} (same SOP Instance UID)` });
        continue;
      }
      if (sop) seen.set(sop, info.filename);
      unique.push(info);
    }

    const sorted = sortInstances(unique);
    const slices: SliceRef[] = [];
    for (const instance of sorted) {
      for (let frame = 0; frame < instance.numberOfFrames; frame++) {
        const geometry = instance.frames?.[frame];
        const position = geometry?.imagePositionPatient ?? (frame === 0 ? instance.imagePositionPatient : undefined);
        const isRgb = instance.layout.pixelFormat === "rgb8";
        const meta: SliceMeta = { index: slices.length };
        if (instance.instanceNumber !== undefined) meta.instanceNumber = instance.instanceNumber;
        if (instance.sliceLocation !== undefined && instance.numberOfFrames === 1) {
          meta.sliceLocation = instance.sliceLocation;
        }
        if (position) meta.imagePositionPatient = position;
        slices.push({
          instance,
          frame,
          rescaleSlope: isRgb ? 1 : (geometry?.rescaleSlope || instance.rescaleSlope),
          rescaleIntercept: isRgb ? 0 : (geometry?.rescaleIntercept ?? instance.rescaleIntercept),
          meta,
        });
      }
    }

    const first = sorted[0];
    const summary: SeriesSummary = {
      seriesInstanceUid: uid,
      sliceCount: slices.length,
      rows: first.layout.rows,
      columns: first.layout.columns,
    };
    const description = sorted.find((i) => i.seriesDescription)?.seriesDescription;
    const study = sorted.find((i) => i.studyDescription)?.studyDescription;
    const modality = sorted.find((i) => i.modality)?.modality;
    if (description) summary.seriesDescription = description;
    if (study) summary.studyDescription = study;
    if (modality) summary.modality = modality;
    entries.push({ summary, slices, instances: sorted, seriesNumber: first.seriesNumber });
  }

  return entries.sort(
    (a, b) =>
      (a.seriesNumber ?? Number.MAX_SAFE_INTEGER) - (b.seriesNumber ?? Number.MAX_SAFE_INTEGER) ||
      (a.summary.seriesDescription ?? "").localeCompare(b.summary.seriesDescription ?? "") ||
      a.summary.seriesInstanceUid.localeCompare(b.summary.seriesInstanceUid),
  );
}

export function findSeries(catalog: Catalog, uid: string): SeriesEntry | undefined {
  return catalog.series.find((entry) => entry.summary.seriesInstanceUid === uid);
}

// ---------------------------------------------------------------------------
// Pixel access
// ---------------------------------------------------------------------------

function frameKey(slice: SliceRef): string {
  const { instance } = slice;
  return `${instance.filePath}\0${instance.size}\0${instance.mtimeMs}\0${slice.frame}`;
}

/** Decoded frames for the given slice indices (LRU-cached, one read per file). */
export async function getDecodedSlices(entry: SeriesEntry, indices: readonly number[]): Promise<DecodedFrame[]> {
  const result = new Array<DecodedFrame>(indices.length);
  const missing = new Map<InstanceInfo, { frame: number; positions: number[] }[]>();

  indices.forEach((index, position) => {
    const slice = entry.slices[index];
    if (!slice) throw new RangeError(`Slice ${index} is out of range`);
    const cached = frameCache.get(frameKey(slice));
    if (cached) {
      result[position] = cached;
      return;
    }
    const list = missing.get(slice.instance) ?? [];
    const existing = list.find((m) => m.frame === slice.frame);
    if (existing) existing.positions.push(position);
    else list.push({ frame: slice.frame, positions: [position] });
    missing.set(slice.instance, list);
  });

  await mapWithConcurrency([...missing.entries()], READ_CONCURRENCY, async ([instance, wanted]) => {
    const bytes = await readFrameBytes(instance, wanted.map((w) => w.frame));
    for (const { frame, positions } of wanted) {
      const decoded = decodeFrame(instance.layout, bytes.get(frame)!);
      const slice = entry.slices[indices[positions[0]]];
      frameCache.set(frameKey(slice), decoded);
      for (const p of positions) result[p] = decoded;
    }
  });
  return result;
}

/** Wire payload for a range of slices (clamped to the series length). */
export async function getSlicePixels(entry: SeriesEntry, start: number, count: number): Promise<SlicePixels[]> {
  const end = Math.min(entry.slices.length, start + count);
  const indices: number[] = [];
  for (let i = start; i < end; i++) indices.push(i);
  const decoded = await getDecodedSlices(entry, indices);
  return indices.map((index, i) => {
    const slice = entry.slices[index];
    const frame = decoded[i];
    const isRgb = frame.format === "rgb8";
    return {
      index,
      rows: frame.rows,
      columns: frame.columns,
      pixelFormat: frame.format,
      rescaleSlope: isRgb ? 1 : slice.rescaleSlope,
      rescaleIntercept: isRgb ? 0 : slice.rescaleIntercept,
      invert: slice.instance.layout.photometric === "MONOCHROME1",
      data: deflateSync(frameToLittleEndianBytes(frame)).toString("base64"),
    };
  });
}

// ---------------------------------------------------------------------------
// Series detail and default window
// ---------------------------------------------------------------------------

/** Window derived from the rescaled pixel range of a frame, ignoring padding. */
export function deriveWindow(frame: DecodedFrame, slice: SliceRef): WindowLevel {
  if (frame.format === "rgb8") return { center: 128, width: 256 };
  const { layout } = slice.instance;
  const { samples } = frame;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (isPadding(layout, v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === Infinity) {
    // Everything is padding; fall back to the full range.
    for (let i = 0; i < samples.length; i++) {
      if (samples[i] < lo) lo = samples[i];
      if (samples[i] > hi) hi = samples[i];
    }
  }
  const { rescaleSlope: slope, rescaleIntercept: intercept } = slice;
  const a = lo * slope + intercept;
  const b = hi * slope + intercept;
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  if (Number.isInteger(slope) && Number.isInteger(intercept)) {
    // Maps min -> 0 and max -> 255 exactly under the DICOM linear function.
    return { center: (min + max + 1) / 2, width: max - min + 1 };
  }
  return { center: (min + max) / 2, width: Math.max(1, max - min) };
}

export function middleSliceIndex(entry: SeriesEntry): number {
  return Math.floor((entry.slices.length - 1) / 2);
}

async function computeDetail(entry: SeriesEntry): Promise<SeriesDetail> {
  const first = entry.slices[0].instance;
  const { layout } = first;

  let defaultWindow: WindowLevel;
  if (layout.pixelFormat === "rgb8") {
    defaultWindow = { center: 128, width: 256 };
  } else if (first.windowCenter !== undefined && first.windowWidth !== undefined && first.windowWidth > 0) {
    defaultWindow = { center: first.windowCenter, width: Math.max(1, first.windowWidth) };
  } else {
    const middle = middleSliceIndex(entry);
    const [frame] = await getDecodedSlices(entry, [middle]);
    defaultWindow = deriveWindow(frame, entry.slices[middle]);
  }

  const detail: SeriesDetail = {
    ...entry.summary,
    bitsStored: layout.bitsStored,
    pixelFormat: layout.pixelFormat,
    photometricInterpretation: layout.photometric,
    defaultWindow,
    slices: entry.slices.map((s) => s.meta),
  };
  const spacing = entry.instances.find((i) => i.pixelSpacing)?.pixelSpacing;
  const thickness = entry.instances.find((i) => i.sliceThickness !== undefined)?.sliceThickness;
  const orientation = first.imageOrientationPatient;
  if (spacing) detail.pixelSpacing = spacing;
  if (thickness !== undefined) detail.sliceThickness = thickness;
  if (orientation) detail.imageOrientationPatient = orientation;
  return detail;
}

/** Series detail (memoized per catalog entry). */
export function getSeriesDetail(entry: SeriesEntry): Promise<SeriesDetail> {
  if (!entry.detail) {
    entry.detail = computeDetail(entry);
    entry.detail.catch(() => {
      entry.detail = undefined;
    });
  }
  return entry.detail;
}
