/**
 * Transfer syntax classification. Only native (uncompressed) encodings are
 * decoded; everything encapsulated is reported as skipped with a readable name.
 */

export const IMPLICIT_VR_LE = "1.2.840.10008.1.2";
export const EXPLICIT_VR_LE = "1.2.840.10008.1.2.1";
export const DEFLATED_EXPLICIT_VR_LE = "1.2.840.10008.1.2.1.99";
export const EXPLICIT_VR_BE = "1.2.840.10008.1.2.2";

const NAMES: Record<string, string> = {
  [IMPLICIT_VR_LE]: "Implicit VR Little Endian",
  [EXPLICIT_VR_LE]: "Explicit VR Little Endian",
  [DEFLATED_EXPLICIT_VR_LE]: "Deflated Explicit VR Little Endian",
  [EXPLICIT_VR_BE]: "Explicit VR Big Endian",
  "1.2.840.10008.1.2.1.98": "Encapsulated Uncompressed Explicit VR Little Endian",
  "1.2.840.10008.1.2.4.50": "JPEG Baseline (Process 1)",
  "1.2.840.10008.1.2.4.51": "JPEG Extended (Process 2 & 4)",
  "1.2.840.10008.1.2.4.53": "JPEG Extended (Process 3 & 5)",
  "1.2.840.10008.1.2.4.55": "JPEG Spectral Selection, Non-Hierarchical",
  "1.2.840.10008.1.2.4.57": "JPEG Lossless, Non-Hierarchical (Process 14)",
  "1.2.840.10008.1.2.4.70": "JPEG Lossless, First-Order Prediction (Process 14 SV1)",
  "1.2.840.10008.1.2.4.80": "JPEG-LS Lossless",
  "1.2.840.10008.1.2.4.81": "JPEG-LS Near-Lossless",
  "1.2.840.10008.1.2.4.90": "JPEG 2000 Lossless",
  "1.2.840.10008.1.2.4.91": "JPEG 2000",
  "1.2.840.10008.1.2.4.92": "JPEG 2000 Part 2 Multi-component Lossless",
  "1.2.840.10008.1.2.4.93": "JPEG 2000 Part 2 Multi-component",
  "1.2.840.10008.1.2.4.94": "JPIP Referenced",
  "1.2.840.10008.1.2.4.95": "JPIP Referenced Deflate",
  "1.2.840.10008.1.2.4.100": "MPEG-2 Main Profile",
  "1.2.840.10008.1.2.4.101": "MPEG-2 High Profile",
  "1.2.840.10008.1.2.4.102": "MPEG-4 AVC/H.264 High Profile",
  "1.2.840.10008.1.2.4.103": "MPEG-4 AVC/H.264 BD-compatible High Profile",
  "1.2.840.10008.1.2.4.104": "MPEG-4 AVC/H.264 High Profile for 2D Video",
  "1.2.840.10008.1.2.4.105": "MPEG-4 AVC/H.264 High Profile for 3D Video",
  "1.2.840.10008.1.2.4.106": "MPEG-4 AVC/H.264 Stereo High Profile",
  "1.2.840.10008.1.2.4.107": "HEVC/H.265 Main Profile",
  "1.2.840.10008.1.2.4.108": "HEVC/H.265 Main 10 Profile",
  "1.2.840.10008.1.2.4.110": "JPEG XL Lossless",
  "1.2.840.10008.1.2.4.111": "JPEG XL JPEG Recompression",
  "1.2.840.10008.1.2.4.112": "JPEG XL",
  "1.2.840.10008.1.2.4.201": "High-Throughput JPEG 2000 Lossless",
  "1.2.840.10008.1.2.4.202": "High-Throughput JPEG 2000 with RPCL Options Lossless",
  "1.2.840.10008.1.2.4.203": "High-Throughput JPEG 2000",
  "1.2.840.10008.1.2.4.204": "JPIP HTJ2K Referenced",
  "1.2.840.10008.1.2.4.205": "JPIP HTJ2K Referenced Deflate",
  "1.2.840.10008.1.2.5": "RLE Lossless",
  "1.2.840.10008.1.2.6.1": "RFC 2557 MIME Encapsulation",
  "1.2.840.10008.1.2.6.2": "XML Encoding",
};

const SUPPORTED = new Set([IMPLICIT_VR_LE, EXPLICIT_VR_LE, DEFLATED_EXPLICIT_VR_LE, EXPLICIT_VR_BE]);

export function transferSyntaxName(uid: string): string {
  return NAMES[uid] ?? (uid.startsWith("1.2.840.10008.1.2.7.") ? "SMPTE ST 2110" : "unknown");
}

export function isSupportedTransferSyntax(uid: string): boolean {
  return SUPPORTED.has(uid);
}

/** Reason string for an unsupported syntax, e.g. "Unsupported transfer syntax: JPEG 2000 (1.2.840.10008.1.2.4.91)". */
export function unsupportedTransferSyntaxReason(uid: string): string {
  return `Unsupported transfer syntax: ${transferSyntaxName(uid)} (${uid})`;
}
