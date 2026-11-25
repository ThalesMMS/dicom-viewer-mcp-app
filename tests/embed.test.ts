import vm from "node:vm";
import { describe, expect, it } from "vitest";
import type { DicomBootstrap } from "../shared/protocol.js";
import { injectBootstrap, serializeForInlineScript } from "../server/embed.js";

const HOSTILE = `</script><script>alert(1)</script> $& $1 $$ $\` <!-- & \u2028\u2029 >`;

function bootstrapWith(description: string): DicomBootstrap {
  const summary = { seriesInstanceUid: "1.2.3", seriesDescription: description, sliceCount: 1, rows: 1, columns: 1 };
  return {
    view: {
      series: [summary],
      selected: {
        ...summary,
        bitsStored: 8,
        pixelFormat: "uint8",
        photometricInterpretation: "MONOCHROME2",
        defaultWindow: { center: 128, width: 256 },
        slices: [{ index: 0 }],
      },
      window: { center: 128, width: 256 },
      skipped: [{ filename: "x$&.dcm", reason: description }],
    },
    slices: [],
  };
}

describe("serializeForInlineScript", () => {
  it("escapes characters that could end the script or confuse parsers", () => {
    const json = serializeForInlineScript({ s: HOSTILE });
    expect(json).not.toMatch(/[<>&\u2028\u2029]/);
    expect(json).toContain("\\u003c/script\\u003e");
    expect(JSON.parse(json)).toEqual({ s: HOSTILE });
  });
});

describe("injectBootstrap", () => {
  const html = "<!DOCTYPE html><html><head><title>x</title></head><body><div id=root></div></body></html>";

  it("injects one script before </head> without breaking out", () => {
    const out = injectBootstrap(html, bootstrapWith(HOSTILE));
    // Exactly one <script> opening and one closing tag were added.
    expect(out.match(/<script/gi)).toHaveLength(1);
    expect(out.match(/<\/script>/gi)).toHaveLength(1);
    expect(out.indexOf("<script>")).toBeLessThan(out.indexOf("</head>"));
    // `$&` was not expanded to "</head>" by String.prototype.replace.
    expect(out.match(/<\/head>/gi)).toHaveLength(1);
    expect(out).toContain("$\\u0026 $1 $$ $` ");

    // Executing the script yields the original data.
    const script = out.slice(out.indexOf("<script>") + 8, out.indexOf("</script>"));
    const context: { window: Record<string, unknown> } = { window: {} };
    vm.runInNewContext(script, context);
    const injected = context.window.__DICOM_BOOTSTRAP__ as DicomBootstrap;
    expect(injected.view.series[0].seriesDescription).toBe(HOSTILE);
    expect(injected.view.skipped[0].filename).toBe("x$&.dcm");
  });

  it("falls back to <body> or the start of the document", () => {
    expect(injectBootstrap("<body class=a>hi</body>", bootstrapWith("d"))).toMatch(/^<body class=a><script>/);
    expect(injectBootstrap("plain", bootstrapWith("d"))).toMatch(/^<script>.*<\/script>plain$/s);
  });
});
