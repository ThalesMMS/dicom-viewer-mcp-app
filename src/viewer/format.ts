/**
 * @file Display formatting and the text sent to the model via
 * updateModelContext. Never includes patient identifiers (the server does
 * not send any).
 */
import {
  WINDOW_PRESETS,
  WINDOW_PRESET_NAMES,
  type SeriesDetail,
  type SeriesSummary,
  type WindowLevel,
  type WindowPresetName,
} from "../../shared/protocol";
import { sameWindow } from "./lut";

/** Rounds for display: integers for large values, 1-2 decimals for small. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  if (abs >= 100) return String(Math.round(n));
  if (abs >= 10) return String(Math.round(n * 10) / 10);
  return String(Math.round(n * 100) / 100);
}

export function seriesLabel(s: Pick<SeriesSummary, "seriesDescription" | "modality">): string {
  const desc = s.seriesDescription?.trim();
  const parts = [desc || "Unnamed series"];
  if (s.modality) parts.push(s.modality);
  return parts.join(" · ");
}

export const PRESET_LABELS: Record<WindowPresetName, string> = {
  "soft-tissue": "Soft tissue",
  lung: "Lung",
  bone: "Bone",
  brain: "Brain",
  liver: "Liver",
  mediastinum: "Mediastinum",
};

/** "default", a preset name, or "custom" for the given window. */
export function matchPreset(win: WindowLevel, defaultWindow: WindowLevel): "default" | WindowPresetName | "custom" {
  if (sameWindow(win, defaultWindow)) return "default";
  for (const name of WINDOW_PRESET_NAMES) {
    if (sameWindow(win, WINDOW_PRESETS[name])) return name;
  }
  return "custom";
}

export interface ModelContextState {
  series: SeriesDetail;
  seriesCount: number;
  sliceIndex: number;
  window: WindowLevel | null;
  inverted: boolean;
}

export function buildModelContextText(s: ModelContextState): string {
  const total = s.series.slices.length;
  const meta = s.series.slices[s.sliceIndex];
  const lines: string[] = [];
  const study = s.series.studyDescription?.trim();
  lines.push(
    `DICOM viewer is showing series "${seriesLabel(s.series)}"` +
      (study ? ` (study "${study}")` : "") +
      (s.seriesCount > 1 ? `, one of ${s.seriesCount} series` : "") +
      ".",
  );
  const where = [`slice ${s.sliceIndex + 1} of ${total}`];
  if (meta?.instanceNumber !== undefined) where.push(`instance number ${meta.instanceNumber}`);
  if (meta?.sliceLocation !== undefined) where.push(`slice location ${formatNumber(meta.sliceLocation)} mm`);
  lines.push(`Current position: ${where.join(", ")}.`);
  if (s.window) {
    const preset = matchPreset(s.window, s.series.defaultWindow);
    const name = preset === "default" ? "default" : preset === "custom" ? "custom" : PRESET_LABELS[preset].toLowerCase();
    lines.push(
      `Window: center ${formatNumber(s.window.center)}, width ${formatNumber(s.window.width)} (${name})` +
        (s.inverted ? ", inverted" : "") +
        ".",
    );
  } else {
    lines.push("Color image (no window/level).");
  }
  return lines.join("\n");
}
