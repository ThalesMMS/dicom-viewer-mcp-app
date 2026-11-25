import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Creates a temp directory with the given files; returns its path. */
export function makeTempDir(files: Record<string, Uint8Array | string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dicom-viewer-test-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
