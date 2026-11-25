/**
 * @file Keeps the model informed of what the user is looking at via
 * `app.updateModelContext`, debounced and only when the text changes.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import { useCallback, useEffect, useRef } from "react";
import type { ViewDicomResult } from "../../shared/protocol";
import type { ViewState } from "../components/Viewer";
import { buildModelContextText } from "../viewer/format";

const DEBOUNCE_MS = 500;

export function useModelContext(app: App | null, view: ViewDicomResult | null): (state: ViewState) => void {
  const appRef = useRef(app);
  const viewRef = useRef(view);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastSent = useRef("");
  const disabled = useRef(false);

  useEffect(() => {
    appRef.current = app;
    viewRef.current = view;
  }, [app, view]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return useCallback((state: ViewState) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const a = appRef.current;
      const v = viewRef.current;
      if (!a || !v || disabled.current) return;
      const caps = a.getHostCapabilities();
      if (caps && !caps.updateModelContext) {
        disabled.current = true;
        return;
      }
      const text = buildModelContextText({
        series: v.selected,
        seriesCount: v.series.length,
        sliceIndex: state.sliceIndex,
        window: state.window,
        inverted: state.inverted,
      });
      if (text === lastSent.current) return;
      lastSent.current = text;
      void (async () => {
        try {
          await a.updateModelContext({ content: [{ type: "text", text }] });
        } catch (err) {
          // Hosts may not implement it; stop trying after the first failure.
          disabled.current = true;
          console.warn("[dicom-viewer] updateModelContext failed:", err);
        }
      })();
    }, DEBOUNCE_MS);
  }, []);
}
