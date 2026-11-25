/**
 * @file DICOM Viewer MCP App entry point.
 *
 * Data sources, in order of preference:
 * 1. `window.__DICOM_BOOTSTRAP__` embedded by the server (bridge-less hosts
 *    such as Open WebUI): rendered directly, no tool calls needed.
 * 2. The MCP Apps bridge: the view-dicom result arrives via `ontoolresult`
 *    and pixel data is paged with the app-only get-dicom-slices tool.
 *
 * The bridge is always attempted (for theme, display mode and model context),
 * but a failed or missing connection never blocks bootstrap rendering.
 */
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyleVariables } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { BOOTSTRAP_GLOBAL, type ViewDicomResult } from "../shared/protocol";
import { IconExitFullscreen, IconFullscreen } from "./components/Icons";
import { SkippedBadge } from "./components/SkippedBadge";
import { StatusScreen } from "./components/StatusScreen";
import { Viewer } from "./components/Viewer";
import { useModelContext } from "./hooks/useModelContext";
import { bootstrapFetcher, bridgeFetcher, callViewDicom, interpretViewResult } from "./host/tools";
import { seriesLabel } from "./viewer/format";
import { parseBootstrap } from "./viewer/validate";
import styles from "./mcp-app.module.css";

const APP_INFO = { name: "DICOM Viewer", version: "2.0.0" };
/** After this long without a bridge connection, explain the situation. */
const CONNECT_TIMEOUT_MS = 5000;
/** Inline height when the host sizes the frame to our content. */
const INLINE_HEIGHT_PX = 480;

const rawBootstrap: unknown = (globalThis as Record<string, unknown>)[BOOTSTRAP_GLOBAL];
const bootstrap = rawBootstrap === undefined ? null : parseBootstrap(rawBootstrap);
if (rawBootstrap !== undefined && !bootstrap) {
  console.error("[dicom-viewer] Ignoring malformed embedded DICOM payload.");
}
const bootstrapFetch = bootstrap ? bootstrapFetcher(bootstrap) : null;

function DicomApp() {
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
  const [view, setView] = useState<ViewDicomResult | null>(bootstrap?.view ?? null);
  const [toolError, setToolError] = useState<string | null>(null);
  const [toolPending, setToolPending] = useState(false);
  const [connectTimedOut, setConnectTimedOut] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const switchRequest = useRef(0);

  const { app, isConnected, error } = useApp({
    appInfo: APP_INFO,
    capabilities: {},
    onAppCreated: (created: App) => {
      created.ontoolinput = () => {
        if (!bootstrap) setToolPending(true);
      };
      created.ontoolresult = (result) => {
        if (bootstrap) return; // The embedded payload is authoritative.
        const outcome = interpretViewResult(result);
        if (outcome.ok) {
          setView(outcome.view);
          setToolError(null);
        } else {
          setToolError(outcome.error);
        }
      };
      created.ontoolcancelled = (params) => {
        if (bootstrap) return;
        setToolError(`The tool call was cancelled${params.reason ? `: ${params.reason}` : "."}`);
      };
      created.onhostcontextchanged = (ctx) => setHostContext((prev) => ({ ...prev, ...ctx }));
      created.onteardown = async () => {
        switchRequest.current++; // Ignore any in-flight series switch.
        return {};
      };
      created.onerror = (err) => console.error("[dicom-viewer] App error:", err);
    },
  });

  useHostStyleVariables(app, app?.getHostContext());

  useEffect(() => {
    if (app) setHostContext((prev) => ({ ...app.getHostContext(), ...prev }));
  }, [app]);

  useEffect(() => {
    if (!error) return;
    // Expected with an embedded payload in bridge-less hosts.
    (bootstrap ? console.info : console.warn)("[dicom-viewer] No MCP Apps bridge:", error.message);
  }, [error]);

  useEffect(() => {
    if (isConnected || bootstrap) return;
    const t = setTimeout(() => setConnectTimedOut(true), CONNECT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [isConnected]);

  const fetchSlices = useMemo(() => {
    if (bootstrapFetch) return bootstrapFetch;
    if (app) return bridgeFetcher(app);
    return () => Promise.reject(new Error("Not connected to the MCP host."));
  }, [app]);

  const reportViewState = useModelContext(isConnected ? app : null, view);

  const selectSeries = useCallback(
    async (seriesInstanceUid: string) => {
      if (!app || seriesInstanceUid === view?.selected.seriesInstanceUid) return;
      const request = ++switchRequest.current;
      setSwitching(seriesInstanceUid);
      setSwitchError(null);
      try {
        const next = await callViewDicom(app, { seriesInstanceUid });
        if (request === switchRequest.current) setView(next);
      } catch (err) {
        if (request === switchRequest.current) {
          setSwitchError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (request === switchRequest.current) setSwitching(null);
      }
    },
    [app, view?.selected.seriesInstanceUid],
  );

  // Display mode / fullscreen.
  const displayMode = hostContext?.displayMode ?? "inline";
  const canFullscreen = isConnected && (hostContext?.availableDisplayModes?.includes("fullscreen") ?? false);
  const setMode = useCallback(
    async (mode: "inline" | "fullscreen") => {
      if (!app) return;
      try {
        const result = await app.requestDisplayMode({ mode });
        setHostContext((prev) => ({ ...prev, displayMode: result.mode }));
      } catch (err) {
        console.warn("[dicom-viewer] requestDisplayMode failed:", err);
      }
    },
    [app],
  );

  useEffect(() => {
    if (displayMode !== "fullscreen" || !canFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) void setMode("inline");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [displayMode, canFullscreen, setMode]);

  // Layout: fill the frame when it has a fixed size (fullscreen, fixed
  // container, or no bridge); otherwise use an intrinsic inline height that
  // the host can auto-size to.
  const dims = hostContext?.containerDimensions;
  const fixedHeight = dims !== undefined && "height" in dims;
  const maxHeight = dims && "maxHeight" in dims ? dims.maxHeight : undefined;
  const fill = !isConnected || displayMode === "fullscreen" || fixedHeight;
  const insets = hostContext?.safeAreaInsets;
  const mainStyle: CSSProperties = {
    height: fill ? "100vh" : INLINE_HEIGHT_PX,
    maxHeight: fill ? undefined : maxHeight,
    paddingTop: insets?.top,
    paddingRight: insets?.right,
    paddingBottom: insets?.bottom,
    paddingLeft: insets?.left,
  };

  let content;
  if (view) {
    const multi = !bootstrap && view.series.length > 1;
    const headerStart = (
      <>
        {multi ? (
          <select
            className={`${styles.select} ${styles.seriesSelect}`}
            aria-label="Series"
            value={switching ?? view.selected.seriesInstanceUid}
            disabled={switching !== null || !app}
            onChange={(e) => void selectSeries(e.target.value)}
          >
            {view.series.map((s) => (
              <option key={s.seriesInstanceUid} value={s.seriesInstanceUid}>
                {seriesLabel(s)} ({s.sliceCount})
              </option>
            ))}
          </select>
        ) : (
          <span className={styles.seriesTitle} title={view.selected.studyDescription}>
            {seriesLabel(view.selected)}
          </span>
        )}
        {switching && (
          <span className={styles.inlineStatus} role="status">
            <span className={styles.spinner} aria-hidden="true" /> Opening series…
          </span>
        )}
        {switchError && (
          <span className={styles.inlineError} role="alert">
            Couldn’t open series: {switchError}
          </span>
        )}
        <SkippedBadge skipped={view.skipped} />
      </>
    );
    const headerEnd = canFullscreen ? (
      <button
        type="button"
        className={styles.iconButton}
        aria-label={displayMode === "fullscreen" ? "Exit fullscreen" : "Enter fullscreen"}
        aria-pressed={displayMode === "fullscreen"}
        title={displayMode === "fullscreen" ? "Exit fullscreen (Esc)" : "Fullscreen"}
        onClick={() => void setMode(displayMode === "fullscreen" ? "inline" : "fullscreen")}
      >
        {displayMode === "fullscreen" ? <IconExitFullscreen /> : <IconFullscreen />}
      </button>
    ) : null;
    content = (
      <Viewer
        key={view.selected.seriesInstanceUid}
        view={view}
        fetchSlices={fetchSlices}
        headerStart={headerStart}
        headerEnd={headerEnd}
        onViewStateChange={reportViewState}
      />
    );
  } else if (toolError) {
    content = (
      <StatusScreen title="Couldn’t open the DICOM series" tone="error">
        {toolError}
      </StatusScreen>
    );
  } else if (!isConnected && (error || connectTimedOut)) {
    content = (
      <StatusScreen title="No MCP Apps host connection">
        <p>
          This viewer receives its images from the <code>view-dicom</code> tool through an MCP Apps host, and none
          answered.
        </p>
        <p>
          For hosts without MCP Apps support, start the server with <code>--embed-series</code> (or{" "}
          <code>DICOM_EMBED=1</code>) so the series is embedded in the page.
        </p>
      </StatusScreen>
    );
  } else if (isConnected) {
    content = (
      <StatusScreen title={toolPending ? "Opening the DICOM series…" : "Waiting for the view-dicom result…"} busy />
    );
  } else {
    content = <StatusScreen title="Connecting to the host…" busy />;
  }

  return (
    <main className={`${styles.main} ${displayMode === "fullscreen" ? styles.fullscreen : ""}`} style={mainStyle}>
      {content}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DicomApp />
  </StrictMode>,
);
