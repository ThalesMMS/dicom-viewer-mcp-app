/**
 * @file Unobtrusive "N files skipped" badge that expands to the list of
 * filenames and reasons.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { SkippedFile } from "../../shared/protocol";
import { IconWarning } from "./Icons";
import styles from "../mcp-app.module.css";

export function SkippedBadge({ skipped }: { skipped: SkippedFile[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (skipped.length === 0) return null;
  const label = `${skipped.length} file${skipped.length === 1 ? "" : "s"} skipped`;
  return (
    <div
      className={styles.skipped}
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className={styles.skippedButton}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        title="Some files in the folder could not be displayed"
      >
        <IconWarning />
        <span>{label}</span>
      </button>
      {open && (
        <div id={panelId} className={styles.skippedPanel} role="region" aria-label="Skipped files">
          <ul>
            {skipped.map((s, i) => (
              <li key={`${s.filename}-${i}`}>
                <span className={styles.skippedName}>{s.filename}</span>
                {s.reason && <span className={styles.skippedReason}>{s.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
