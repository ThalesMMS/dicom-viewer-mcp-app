import path from "node:path";
import { describe, expect, it } from "vitest";
import { CliError, isLoopbackHost, parseCli } from "../server/cli.js";

const cwd = path.resolve("/work");

describe("parseCli", () => {
  it("uses defaults", () => {
    expect(parseCli([], {}, cwd)).toEqual({
      stdio: false,
      help: false,
      dicomDir: path.resolve(cwd, "dicom"),
      embedSeries: false,
      host: "127.0.0.1",
      port: 3001,
      corsOrigins: [],
    });
  });

  it("prefers flags over environment over defaults", () => {
    const env = { DICOM_DIR: "/env/dir", DICOM_EMBED: "1", HOST: "::1", PORT: "4000", CORS_ORIGIN: "https://a.test, https://b.test" };
    const fromEnv = parseCli([], env, cwd);
    expect(fromEnv.dicomDir).toBe(path.resolve("/env/dir"));
    expect(fromEnv.embedSeries).toBe(true);
    expect(fromEnv.host).toBe("::1");
    expect(fromEnv.port).toBe(4000);
    expect(fromEnv.corsOrigins).toEqual(["https://a.test", "https://b.test"]);

    const fromFlags = parseCli(["--stdio", "--dir", "rel/scans", "--host=localhost", "--port", "5000"], env, cwd);
    expect(fromFlags.stdio).toBe(true);
    expect(fromFlags.dicomDir).toBe(path.resolve(cwd, "rel/scans"));
    expect(fromFlags.host).toBe("localhost");
    expect(fromFlags.port).toBe(5000);

    expect(parseCli(["--dir=/x y"], {}, cwd).dicomDir).toBe(path.resolve("/x y"));
    expect(parseCli(["--embed-series"], {}, cwd).embedSeries).toBe(true);
    expect(parseCli(["-h"], {}, cwd).help).toBe(true);
  });

  it("rejects bad input", () => {
    expect(() => parseCli(["--dir"], {}, cwd)).toThrow(CliError);
    expect(() => parseCli(["--dir", "--stdio"], {}, cwd)).toThrow(/needs a value/);
    expect(() => parseCli(["--bogus"], {}, cwd)).toThrow(/Unknown argument/);
    expect(() => parseCli(["--port", "99999"], {}, cwd)).toThrow(/Invalid port/);
  });
});

describe("isLoopbackHost", () => {
  it("recognizes loopback addresses", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) expect(isLoopbackHost(host)).toBe(false);
  });
});
