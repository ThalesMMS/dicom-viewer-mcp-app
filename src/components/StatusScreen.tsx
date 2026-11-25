/**
 * @file Full-area message for the waiting / error / no-host states.
 */
import type { ReactNode } from "react";
import styles from "../mcp-app.module.css";

export function StatusScreen(props: {
  title: string;
  tone?: "info" | "error";
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={styles.statusScreen} role={props.tone === "error" ? "alert" : "status"}>
      {props.busy && <span className={`${styles.spinner} ${styles.spinnerLarge}`} aria-hidden="true" />}
      <h1 className={props.tone === "error" ? styles.statusTitleError : styles.statusTitle}>{props.title}</h1>
      {props.children && <div className={styles.statusText}>{props.children}</div>}
    </div>
  );
}
