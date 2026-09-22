// Static file server for the gap fixtures. No framework: node:http plus
// node:fs. Two independent servers so the cross-origin iframe fixture is
// genuinely cross-origin, not same-origin-with-different-port pretending.
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = fileURLToPath(new URL(".", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path)] ?? "application/octet-stream";
}

function makeServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    // Reject any traversal outside the fixtures directory before touching
    // the filesystem.
    const resolved = normalize(join(FIXTURES_DIR, pathname));
    if (!resolved.startsWith(FIXTURES_DIR)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    readFile(resolved)
      .then((body) => {
        res.writeHead(200, { "content-type": contentTypeFor(resolved) });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404).end("not found");
      });
  });
}

/** Starts a fixtures server on the given port (0 for an ephemeral port) and resolves once listening. */
export function start(port: number): Promise<{ server: Server; port: number }> {
  const server = makeServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort =
        typeof address === "object" && address ? address.port : port;
      resolve({ server, port: actualPort });
    });
  });
}

export function stop(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

const isMain =
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file://").href;

if (isMain) {
  const primary = await start(8791);
  const foreign = await start(8792);
  console.log(`fixtures: http://localhost:${primary.port} (primary)`);
  console.log(`fixtures: http://localhost:${foreign.port} (foreign origin)`);
}
