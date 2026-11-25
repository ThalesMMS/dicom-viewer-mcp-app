/**
 * @file Image viewport: canvas rendering plus pointer / wheel interactions.
 *
 * - Pointer events with pointer capture (mouse, touch, pen).
 * - Left drag = active tool; right drag = W/L; middle or Shift+drag = pan;
 *   two-finger pinch = zoom + pan.
 * - Native non-passive wheel listener: plain wheel steps slices (with delta
 *   accumulation), Ctrl/Cmd+wheel zooms at the cursor.
 */
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { WindowLevel } from "../../shared/protocol";
import { IDENTITY_TRANSFORM, zoomAbout } from "../viewer/geometry";
import { dragWindow, windowDragRate } from "../viewer/lut";
import { SliceRenderer } from "../viewer/renderer";
import type { DecodedSlice, ToolMode, ViewTransform } from "../viewer/types";
import { WheelAccumulator, normalizeWheelDelta, wheelZoomFactor } from "../viewer/wheel";
import styles from "../mcp-app.module.css";

type DragState =
  | { kind: "window"; id: number; x0: number; y0: number; start: WindowLevel; rate: number }
  | { kind: "pan"; id: number; x0: number; y0: number; start: ViewTransform }
  | { kind: "zoom"; id: number; x0: number; y0: number; start: ViewTransform; ax: number; ay: number }
  | {
      kind: "pinch";
      ids: [number, number];
      dist0: number;
      mid0: { x: number; y: number };
      start: ViewTransform;
    };

export interface ViewportProps {
  /** Slice to draw (may be a stale neighbour while the current one loads). */
  slice: DecodedSlice | undefined;
  stale: boolean;
  isColor: boolean;
  window: WindowLevel;
  invert: boolean;
  tool: ToolMode;
  transform: ViewTransform;
  pixelSpacing?: readonly [number, number];
  /** Rescaled data range, for W/L drag sensitivity. */
  dataRange: number;
  ariaLabel: string;
  setTransform: Dispatch<SetStateAction<ViewTransform>>;
  setWindow: Dispatch<SetStateAction<WindowLevel>>;
  onSliceStep: (delta: number) => void;
  onSize: (width: number, height: number) => void;
  size: { width: number; height: number };
  /** Overlays and status layers drawn above the canvas. */
  children?: ReactNode;
}

export function Viewport(props: ViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SliceRenderer | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number; type: string }>());
  const drag = useRef<DragState | null>(null);
  const [dragKind, setDragKind] = useState<DragState["kind"] | null>(null);
  const [magnified, setMagnified] = useState(false);

  // Latest props for long-lived native listeners.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  const { onSize } = props;

  // Track the viewport size.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const report = () => onSize(el.clientWidth, el.clientHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onSize]);

  // Render in an animation frame whenever an input changes.
  const { slice, window: win, invert, transform, pixelSpacing, size } = props;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return;
    rendererRef.current ??= new SliceRenderer(canvas);
    const renderer = rendererRef.current;
    const frame = requestAnimationFrame(() => {
      const result = renderer.render({
        slice,
        window: win,
        invert,
        transform,
        pixelSpacing,
        cssWidth: size.width,
        cssHeight: size.height,
      });
      setMagnified(result.magnified);
    });
    return () => cancelAnimationFrame(frame);
  }, [slice, win, invert, transform, pixelSpacing, size]);

  // Native wheel listener: React's onWheel is passive, so preventDefault
  // would be ignored there.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const acc = new WheelAccumulator();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = latest.current;
      const dy = normalizeWheelDelta(e.deltaY, e.deltaMode, el.clientHeight || 800);
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const ax = e.clientX - rect.left - rect.width / 2;
        const ay = e.clientY - rect.top - rect.height / 2;
        p.setTransform((t) => zoomAbout(t, wheelZoomFactor(dy), ax, ay));
        return;
      }
      const steps = acc.push(dy, e.timeStamp);
      if (steps !== 0) p.onSliceStep(steps);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const relative = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  };

  const beginSingle = (id: number, x: number, y: number, kind: "window" | "pan" | "zoom") => {
    const p = latest.current;
    if (kind === "window") {
      drag.current = { kind, id, x0: x, y0: y, start: p.window, rate: windowDragRate(p.dataRange) };
    } else if (kind === "pan") {
      drag.current = { kind, id, x0: x, y0: y, start: p.transform };
    } else {
      const r = relative(x, y);
      drag.current = { kind, id, x0: x, y0: y, start: p.transform, ax: r.x, ay: r.y };
    }
    setDragKind(kind);
  };

  const beginPinch = () => {
    const touches = [...pointers.current.entries()].filter(([, v]) => v.type === "touch");
    if (touches.length < 2) return false;
    const [[ida, a], [idb, b]] = touches;
    drag.current = {
      kind: "pinch",
      ids: [ida, idb],
      dist0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mid0: relative((a.x + b.x) / 2, (a.y + b.y) / 2),
      start: latest.current.transform,
    };
    setDragKind("pinch");
    return true;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = latest.current;
    if (e.pointerType === "mouse" && e.button > 2) return;
    const el = e.currentTarget;
    el.focus({ preventScroll: true });
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // Pointer may already be gone; harmless.
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    e.preventDefault();

    if (e.pointerType === "touch" && pointers.current.size >= 2) {
      beginPinch();
      return;
    }
    if (pointers.current.size > 1) return;

    let kind: "window" | "pan" | "zoom" = p.tool;
    if (e.button === 2) kind = "window";
    else if (e.button === 1 || e.shiftKey) kind = "pan";
    if (kind === "window" && p.isColor) kind = "pan";
    beginSingle(e.pointerId, e.clientX, e.clientY, kind);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const entry = pointers.current.get(e.pointerId);
    if (!entry) return;
    entry.x = e.clientX;
    entry.y = e.clientY;
    const d = drag.current;
    if (!d) return;
    const p = latest.current;
    if (d.kind === "pinch") {
      const a = pointers.current.get(d.ids[0]);
      const b = pointers.current.get(d.ids[1]);
      if (!a || !b) return;
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mid = relative((a.x + b.x) / 2, (a.y + b.y) / 2);
      const z = zoomAbout(d.start, dist / d.dist0, d.mid0.x, d.mid0.y);
      p.setTransform({ zoom: z.zoom, panX: z.panX + mid.x - d.mid0.x, panY: z.panY + mid.y - d.mid0.y });
      return;
    }
    if (e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (d.kind === "window") {
      p.setWindow(dragWindow(d.start, dx, dy, d.rate));
    } else if (d.kind === "pan") {
      p.setTransform({ ...d.start, panX: d.start.panX + dx, panY: d.start.panY + dy });
    } else {
      p.setTransform(zoomAbout(d.start, Math.exp(-dy * 0.01), d.ax, d.ay));
    }
  };

  const endPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pinch") {
      if (d.ids.includes(e.pointerId)) {
        // Continue as a one-finger pan with the remaining pointer, if any.
        const rest = [...pointers.current.entries()][0];
        if (rest) beginSingle(rest[0], rest[1].x, rest[1].y, "pan");
        else {
          drag.current = null;
          setDragKind(null);
        }
      }
      return;
    }
    if (d.id === e.pointerId) {
      drag.current = null;
      setDragKind(null);
    }
  };

  const cursorClass =
    dragKind === "pan" || dragKind === "pinch"
      ? styles.cursorGrabbing
      : props.tool === "pan" || (props.tool === "window" && props.isColor)
        ? styles.cursorGrab
        : props.tool === "zoom"
          ? styles.cursorZoom
          : styles.cursorWindow;

  return (
    <div
      ref={containerRef}
      className={`${styles.viewport} ${cursorClass}`}
      tabIndex={0}
      role="application"
      aria-roledescription="image viewer"
      aria-label="Image viewport. Arrow keys change slice, Page Up and Page Down jump 10, plus and minus zoom, R resets, I inverts."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onLostPointerCapture={endPointer}
      onContextMenu={(e) => e.preventDefault()}
      onDoubleClick={() => props.setTransform(IDENTITY_TRANSFORM)}
    >
      <canvas
        ref={canvasRef}
        className={`${styles.canvas} ${magnified ? styles.pixelated : ""} ${props.stale ? styles.stale : ""}`}
        role="img"
        aria-label={props.ariaLabel}
      />
      {props.children}
    </div>
  );
}
