/**
 * Entry point of the `mcp-server-dicom-viewer` bin.
 *
 * Run with: node dist/index.js [--stdio] [--dir <path>] [--embed-series]
 * (development: npx tsx main.ts ...). See `--help` for every option.
 */

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { CliError, HELP_TEXT, isLoopbackHost, parseCli, type CliOptions } from "./server/cli.js";
import { createServer } from "./server.js";

/**
 * Starts an MCP server with Streamable HTTP transport in stateless mode.
 *
 * @param createServer - Factory function that creates a new McpServer instance per request.
 */
export async function startStreamableHTTPServer(
  createServer: () => McpServer,
  options: Pick<CliOptions, "host" | "port" | "corsOrigins">,
): Promise<void> {
  const { host, port, corsOrigins } = options;

  if (!isLoopbackHost(host)) {
    console.error(
      `WARNING: binding to non-loopback address ${host}. This server has NO authentication and ` +
        "serves medical images to anyone who can reach it; DNS-rebinding protection is off. " +
        "Only do this on a trusted network or behind an authenticating proxy.",
    );
  }

  // createMcpExpressApp enables DNS-rebinding (Host header) protection for loopback hosts.
  const app = createMcpExpressApp({ host });
  if (corsOrigins.length > 0) {
    app.use(cors({ origin: corsOrigins, exposedHeaders: ["Mcp-Session-Id"] }));
  }

  app.all("/mcp", async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const httpServer = app.listen(port, host, (err?: Error) => {
    if (err) {
      console.error("Failed to start server:", err);
      process.exit(1);
    }
    const shownHost = host.includes(":") ? `[${host}]` : host;
    console.log(`MCP server listening on http://${shownHost}:${port}/mcp`);
  });

  const shutdown = () => {
    console.log("\nShutting down...");
    httpServer.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Starts an MCP server with stdio transport. stdout carries only protocol
 * messages, so console.log/info/debug are redirected to stderr.
 *
 * @param createServer - Factory function that creates a new McpServer instance.
 */
export async function startStdioServer(createServer: () => McpServer): Promise<void> {
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  await createServer().connect(new StdioServerTransport());
}

async function main() {
  let options: CliOptions;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`${error.message}\n\n${HELP_TEXT}`);
      process.exit(2);
    }
    throw error;
  }

  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const factory = () => createServer({ dicomDir: options.dicomDir, embedSeries: options.embedSeries });
  console.error(
    `[dicom-viewer] DICOM directory: ${options.dicomDir}` + (options.embedSeries ? " (embed-series on)" : ""),
  );

  if (options.stdio) {
    await startStdioServer(factory);
  } else {
    await startStreamableHTTPServer(factory, options);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
