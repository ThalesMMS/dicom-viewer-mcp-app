/**
 * Command-line / environment configuration for the `mcp-server-dicom-viewer` bin.
 */
import path from "node:path";
import { SERVER_VERSION } from "./version.js";

export interface CliOptions {
  stdio: boolean;
  help: boolean;
  /** Absolute DICOM directory. */
  dicomDir: string;
  embedSeries: boolean;
  host: string;
  port: number;
  /** Allowed CORS origins (empty: CORS disabled). */
  corsOrigins: string[];
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3001;

export const HELP_TEXT = `mcp-server-dicom-viewer ${SERVER_VERSION}
MCP App server that shows DICOM series in an interactive viewer.

Usage:
  node dist/index.js [--stdio] [--dir <path>] [--embed-series] [--host <host>] [--port <port>]

Options:
  --stdio            Use the stdio transport (default: Streamable HTTP on /mcp).
  --dir <path>       Folder with the DICOM files (*.dcm, or extension-less files
                     with the DICM signature; not recursive).
                     Default: $DICOM_DIR, else ./dicom in the current directory.
  --embed-series     Embed the default series in the viewer HTML, for hosts
                     without the MCP Apps bridge (e.g. Open WebUI). Also DICOM_EMBED=1.
  --host <host>      HTTP bind address. Default: $HOST, else ${DEFAULT_HOST}.
  --port <port>      HTTP port. Default: $PORT, else ${DEFAULT_PORT}.
  -h, --help         Show this help.

Environment:
  DICOM_DIR          DICOM folder (overridden by --dir).
  DICOM_EMBED        "1"/"true" enables --embed-series.
  HOST, PORT         HTTP bind address and port (overridden by --host/--port).
  CORS_ORIGIN        Comma-separated list of origins allowed to call the HTTP
                     endpoint from a browser. Default: none (CORS disabled).

The HTTP server has no authentication. Keep it on a loopback address unless the
network is trusted: it serves medical images.
`;

function truthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Parses argv (without the node/script prefix) and the environment.
 * Precedence: CLI flag, then environment variable, then default.
 */
export function parseCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): CliOptions {
  let stdio = false;
  let help = false;
  let dir: string | undefined;
  let embed = false;
  let host: string | undefined;
  let port: string | undefined;

  const valueOf = (flag: string, index: number, inline: string | undefined): [string, number] => {
    if (inline !== undefined) {
      if (!inline) throw new CliError(`${flag} needs a value`);
      return [inline, index];
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new CliError(`${flag} needs a value`);
    return [next, index + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith("--") && eq > 0 ? arg.slice(eq + 1) : undefined;
    switch (flag) {
      case "--stdio":
        stdio = true;
        break;
      case "-h":
      case "--help":
        help = true;
        break;
      case "--embed-series":
        embed = true;
        break;
      case "--dir":
        [dir, i] = valueOf(flag, i, inline);
        break;
      case "--host":
        [host, i] = valueOf(flag, i, inline);
        break;
      case "--port":
        [port, i] = valueOf(flag, i, inline);
        break;
      default:
        throw new CliError(`Unknown argument: ${arg}`);
    }
  }

  const portText = port ?? env.PORT ?? String(DEFAULT_PORT);
  const portNumber = Number(portText);
  if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
    throw new CliError(`Invalid port: ${portText}`);
  }

  const dirText = dir ?? (env.DICOM_DIR?.trim() || undefined) ?? "dicom";
  return {
    stdio,
    help,
    dicomDir: path.resolve(cwd, dirText),
    embedSeries: embed || truthy(env.DICOM_EMBED),
    host: host ?? (env.HOST?.trim() || DEFAULT_HOST),
    port: portNumber,
    corsOrigins: (env.CORS_ORIGIN ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  };
}

/** Loopback addresses keep the SDK's DNS-rebinding protection meaningful. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}
