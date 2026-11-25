/**
 * @file Corner text, orientation markers and scale bar drawn over the image.
 * Purely presentational and hidden from pointer events. Never shows patient
 * identifiers.
 */
import type { SeriesDetail, SliceMeta, WindowLevel } from "../../shared/protocol";
import { formatNumber, seriesLabel } from "../viewer/format";
import type { ScaleBar } from "../viewer/geometry";
import type { OrientationMarkers } from "../viewer/orientation";
import styles from "../mcp-app.module.css";

export interface OverlaysProps {
  series: SeriesDetail;
  sliceIndex: number;
  meta: SliceMeta | undefined;
  window: WindowLevel | null;
  inverted: boolean;
  zoomPercent: number;
  markers: OrientationMarkers | null;
  scaleBar: ScaleBar | null;
}

export function Overlays(p: OverlaysProps) {
  const total = p.series.slices.length;
  const spacing = p.series.pixelSpacing;
  return (
    <div className={styles.overlays} aria-hidden="true">
      <div className={`${styles.corner} ${styles.topLeft}`}>
        <div className={styles.overlayStrong}>{seriesLabel(p.series)}</div>
        {p.series.studyDescription && <div>{p.series.studyDescription}</div>}
        <div>
          {p.series.columns} × {p.series.rows}
          {spacing && ` · ${formatNumber(spacing[1])} × ${formatNumber(spacing[0])} mm`}
        </div>
        {p.series.sliceThickness !== undefined && <div>Thickness {formatNumber(p.series.sliceThickness)} mm</div>}
      </div>
      <div className={`${styles.corner} ${styles.topRight}`}>
        <div className={styles.overlayStrong}>
          Slice {p.sliceIndex + 1} / {total}
        </div>
        {p.meta?.instanceNumber !== undefined && <div>Instance {p.meta.instanceNumber}</div>}
        {p.meta?.sliceLocation !== undefined && <div>Location {formatNumber(p.meta.sliceLocation)} mm</div>}
      </div>
      <div className={`${styles.corner} ${styles.bottomLeft}`}>
        <div>
          {p.window ? `W: ${formatNumber(p.window.width)} L: ${formatNumber(p.window.center)}` : "RGB"}
          {p.inverted ? " · Inverted" : ""}
        </div>
        <div>Zoom {Math.round(p.zoomPercent)}%</div>
      </div>
      {p.scaleBar && (
        <div className={`${styles.corner} ${styles.bottomRight}`}>
          <div className={styles.scaleBar} style={{ width: `${p.scaleBar.px}px` }} />
          <div>{p.scaleBar.label}</div>
        </div>
      )}
      {p.markers && (
        <>
          <div className={`${styles.marker} ${styles.markerTop}`}>{p.markers.top}</div>
          <div className={`${styles.marker} ${styles.markerBottom}`}>{p.markers.bottom}</div>
          <div className={`${styles.marker} ${styles.markerLeft}`}>{p.markers.left}</div>
          <div className={`${styles.marker} ${styles.markerRight}`}>{p.markers.right}</div>
        </>
      )}
    </div>
  );
}
