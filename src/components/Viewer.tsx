/**
 * @file The stack viewer for one series: toolbar, image viewport with
 * overlays, slice navigation and loading progress. Remount it (via `key`)
 * when the series changes so all view state starts fresh.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  WINDOW_PRESETS,
  WINDOW_PRESET_NAMES,
  type ViewDicomResult,
  type WindowLevel,
  type WindowPresetName,
} from "../../shared/protocol";
import { useSliceLoader, type FetchSlices } from "../hooks/useSliceLoader";
import { bytesPerSample, rescaledRange } from "../viewer/decode";
import { PRESET_LABELS, formatNumber, matchPreset, seriesLabel } from "../viewer/format";
import { IDENTITY_TRANSFORM, fitScale, scaleBar, zoomAbout } from "../viewer/geometry";
import { orientationMarkers } from "../viewer/orientation";
import type { ToolMode, ViewTransform } from "../viewer/types";
import {
  IconContrast,
  IconInvert,
  IconMinus,
  IconNext,
  IconOverlay,
  IconPan,
  IconPlus,
  IconPrev,
  IconReset,
  IconZoomTool,
} from "./Icons";
import { Overlays } from "./Overlays";
import { Viewport } from "./Viewport";
import styles from "../mcp-app.module.css";

export interface ViewState {
  sliceIndex: number;
  /** null for color images. */
  window: WindowLevel | null;
  inverted: boolean;
}

export interface ViewerProps {
  view: ViewDicomResult;
  fetchSlices: FetchSlices;
  /** Series title / selector and badges, left side of the top bar. */
  headerStart: ReactNode;
  /** Extra controls at the right end of the top bar (e.g. fullscreen). */
  headerEnd?: ReactNode;
  onViewStateChange?: (state: ViewState) => void;
}

const ZOOM_STEP = 1.25;
/** How far (in slices) a neighbour may be shown, dimmed, while loading. */
const STALE_NEIGHBOUR_DISTANCE = 16;

function ToolButton(props: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      className={styles.iconButton}
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={props.shortcut ? `${props.label} (${props.shortcut})` : props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function Viewer({ view, fetchSlices, headerStart, headerEnd, onViewStateChange }: ViewerProps) {
  const series = view.selected;
  const total = series.slices.length;
  const isColor = series.pixelFormat === "rgb8";
  const lastIndex = Math.max(0, total - 1);

  const [sliceIndex, setSliceIndex] = useState(() => Math.floor(lastIndex / 2));
  const [win, setWin] = useState<WindowLevel>(view.window);
  const [userInvert, setUserInvert] = useState(false);
  const [tool, setTool] = useState<ToolMode>(isColor ? "pan" : "window");
  const [showOverlays, setShowOverlays] = useState(true);
  const [transform, setTransform] = useState<ViewTransform>(IDENTITY_TRANSFORM);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [announcement, setAnnouncement] = useState("");

  const onSize = useCallback((width: number, height: number) => {
    setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
  }, []);

  const estimatedSliceBytes = series.rows * series.columns * bytesPerSample(series.pixelFormat);
  const loader = useSliceLoader(series.seriesInstanceUid, total, estimatedSliceBytes, fetchSlices);

  useEffect(() => {
    loader?.setFocus(sliceIndex);
  }, [loader, sliceIndex]);

  const clamp = useCallback((i: number) => Math.max(0, Math.min(lastIndex, Math.round(i))), [lastIndex]);
  const goTo = useCallback((i: number) => setSliceIndex(clamp(i)), [clamp]);
  const step = useCallback((d: number) => setSliceIndex((i) => clamp(i + d)), [clamp]);

  // Current slice, or a dimmed neighbour while it loads.
  const current = loader?.get(sliceIndex);
  const displayed = current ?? loader?.nearest(sliceIndex, STALE_NEIGHBOUR_DISTANCE);
  const status = loader?.status(sliceIndex) ?? "pending";
  const progress = loader?.progress();
  const cachedInWindow = loader?.cachedInWindow() ?? 0;

  const dataRange = useMemo(() => {
    if (!displayed || isColor) return win.width * 2;
    const r = rescaledRange(displayed);
    return r.max - r.min;
  }, [displayed, isColor, win.width]);

  const fit = fitScale(size.width, size.height, series);
  const zoomPercent = fit.sx * transform.zoom * 100;
  const markers = useMemo(() => orientationMarkers(series.imageOrientationPatient), [series.imageOrientationPatient]);
  const bar = series.pixelSpacing
    ? scaleBar(series.pixelSpacing[1] / (fit.sx * transform.zoom), Math.min(160, size.width * 0.3))
    : null;

  const resetAll = useCallback(() => {
    setTransform(IDENTITY_TRANSFORM);
    setWin(view.window);
  }, [view.window]);
  const zoomBy = useCallback((f: number) => setTransform((t) => zoomAbout(t, f, 0, 0)), []);

  // Report view state (the host-facing side debounces).
  useEffect(() => {
    onViewStateChange?.({ sliceIndex, window: isColor ? null : win, inverted: userInvert });
  }, [onViewStateChange, sliceIndex, win, isColor, userInvert]);

  // Announce slice changes sparingly.
  useEffect(() => {
    const t = setTimeout(() => setAnnouncement(`Slice ${sliceIndex + 1} of ${total}`), 800);
    return () => clearTimeout(t);
  }, [sliceIndex, total]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, select, textarea, [contenteditable='true']")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let handled = true;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowUp":
        step(-1);
        break;
      case "ArrowRight":
      case "ArrowDown":
        step(1);
        break;
      case "PageUp":
        step(-10);
        break;
      case "PageDown":
        step(10);
        break;
      case "Home":
        goTo(0);
        break;
      case "End":
        goTo(lastIndex);
        break;
      case "+":
      case "=":
        zoomBy(ZOOM_STEP);
        break;
      case "-":
      case "_":
        zoomBy(1 / ZOOM_STEP);
        break;
      case "0":
      case "r":
      case "R":
        resetAll();
        break;
      case "i":
      case "I":
        if (!isColor) setUserInvert((v) => !v);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };

  const presetValue = matchPreset(win, series.defaultWindow);
  const onPreset = (value: string) => {
    if (value === "default") setWin(series.defaultWindow);
    else if ((WINDOW_PRESET_NAMES as string[]).includes(value)) setWin({ ...WINDOW_PRESETS[value as WindowPresetName] });
  };

  const meta = series.slices[sliceIndex];
  const canvasLabel =
    `${seriesLabel(series)}, slice ${sliceIndex + 1} of ${total}` +
    (meta?.sliceLocation !== undefined ? `, location ${formatNumber(meta.sliceLocation)} mm` : "") +
    (isColor ? "" : `, window width ${formatNumber(win.width)} level ${formatNumber(win.center)}`) +
    (status === "ready" ? "" : status === "error" ? " (failed to load)" : " (loading)");

  const showProgress =
    progress !== undefined && (progress.loading || cachedInWindow < progress.target || progress.failedChunks > 0);

  return (
    <div className={styles.viewer} onKeyDown={onKeyDown}>
      <div className={styles.bar}>
        <div className={styles.barStart}>{headerStart}</div>
        <div className={styles.toolbar} role="toolbar" aria-label="Viewer tools">
          <div className={styles.toolGroup}>
            {!isColor && (
              <ToolButton label="Window/level tool" pressed={tool === "window"} onClick={() => setTool("window")}>
                <IconContrast />
              </ToolButton>
            )}
            <ToolButton label="Pan tool" pressed={tool === "pan"} onClick={() => setTool("pan")}>
              <IconPan />
            </ToolButton>
            <ToolButton label="Zoom tool" pressed={tool === "zoom"} onClick={() => setTool("zoom")}>
              <IconZoomTool />
            </ToolButton>
          </div>
          <div className={styles.toolGroup}>
            <ToolButton label="Zoom out" shortcut="-" onClick={() => zoomBy(1 / ZOOM_STEP)}>
              <IconMinus />
            </ToolButton>
            <ToolButton label="Zoom in" shortcut="+" onClick={() => zoomBy(ZOOM_STEP)}>
              <IconPlus />
            </ToolButton>
            <ToolButton label="Reset view and window" shortcut="R" onClick={resetAll}>
              <IconReset />
            </ToolButton>
          </div>
          {!isColor && (
            <div className={styles.toolGroup}>
              <ToolButton
                label="Invert"
                shortcut="I"
                pressed={userInvert}
                onClick={() => setUserInvert((v) => !v)}
              >
                <IconInvert />
              </ToolButton>
              <select
                className={styles.select}
                aria-label="Window preset"
                value={presetValue}
                onChange={(e) => onPreset(e.target.value)}
              >
                <option value="default">Default</option>
                {WINDOW_PRESET_NAMES.map((name) => (
                  <option key={name} value={name}>
                    {PRESET_LABELS[name]}
                  </option>
                ))}
                {presetValue === "custom" && (
                  <option value="custom" disabled>
                    Custom
                  </option>
                )}
              </select>
            </div>
          )}
          <div className={styles.toolGroup}>
            <ToolButton label="Show overlays" pressed={showOverlays} onClick={() => setShowOverlays((v) => !v)}>
              <IconOverlay />
            </ToolButton>
            {headerEnd}
          </div>
        </div>
      </div>

      <Viewport
        slice={displayed}
        stale={!current && displayed !== undefined}
        isColor={isColor}
        window={win}
        invert={userInvert}
        tool={tool}
        transform={transform}
        pixelSpacing={series.pixelSpacing}
        dataRange={dataRange}
        ariaLabel={canvasLabel}
        setTransform={setTransform}
        setWindow={setWin}
        onSliceStep={step}
        onSize={onSize}
        size={size}
      >
        {showOverlays && (
          <Overlays
            series={series}
            sliceIndex={sliceIndex}
            meta={meta}
            window={isColor ? null : win}
            inverted={userInvert}
            zoomPercent={zoomPercent}
            markers={markers}
            scaleBar={bar}
          />
        )}
        {status === "error" ? (
          <div
            className={styles.errorBox}
            role="alert"
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <div>
              Couldn’t load slice {sliceIndex + 1}
              {loader?.errorMessage(sliceIndex) ? `: ${loader.errorMessage(sliceIndex)}` : "."}
            </div>
            <button type="button" className={styles.textButton} onClick={() => loader?.retry()}>
              Retry
            </button>
          </div>
        ) : status !== "ready" ? (
          <div className={displayed ? styles.statusPill : styles.statusCenter}>
            <span className={styles.spinner} aria-hidden="true" />
            <span>Loading slice {sliceIndex + 1}…</span>
          </div>
        ) : null}
      </Viewport>

      <div className={styles.sliceBar}>
        {total > 1 && (
          <>
            <ToolButton label="Previous slice" disabled={sliceIndex === 0} onClick={() => step(-1)}>
              <IconPrev />
            </ToolButton>
            <input
              type="range"
              className={styles.slider}
              min={0}
              max={lastIndex}
              step={1}
              value={sliceIndex}
              aria-label="Slice"
              aria-valuetext={`Slice ${sliceIndex + 1} of ${total}`}
              onChange={(e) => goTo(Number(e.target.value))}
            />
            <ToolButton label="Next slice" disabled={sliceIndex === lastIndex} onClick={() => step(1)}>
              <IconNext />
            </ToolButton>
          </>
        )}
        <span className={styles.sliceCount}>
          {sliceIndex + 1} / {total}
        </span>
        {showProgress && progress && (
          <span className={styles.progressWrap}>
            {progress.failedChunks > 0 ? (
              <button type="button" className={styles.textButton} onClick={() => loader?.retry()}>
                Some slices failed · Retry
              </button>
            ) : (
              <>
                <progress
                  className={styles.progress}
                  max={progress.target}
                  value={cachedInWindow}
                  aria-label="Slices loaded"
                />
                <span className={styles.progressText}>
                  {cachedInWindow}/{progress.target}
                </span>
              </>
            )}
          </span>
        )}
      </div>

      <div className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
