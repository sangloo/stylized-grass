// A static server for the example: the repository's own files, plus Three.js
// from node_modules under /vendor/. Localhost only.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const root = dirname(fileURLToPath(import.meta.url));
const three = dirname(createRequire(import.meta.url).resolve("three"));
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
};

export async function serve(port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let base = root;
    let path = decodeURIComponent(url.pathname).slice(1);
    if (path.startsWith("vendor/")) {
      base = three;
      path = path.slice(7);
    }
    if (path === "") {
      res.writeHead(302, { Location: "/examples/" });
      res.end();
      return;
    }
    if (path.endsWith("/")) path += "index.html";
    const file = resolve(base, path);
    const allowed =
      file.startsWith(base + sep) &&
      TYPES[extname(file)] &&
      (base === three || !file.slice(root.length).includes("node_modules"));
    if (!allowed) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        "Content-Type": TYPES[extname(file)],
        "Cache-Control": "no-store",
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", ok);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve(Number(process.argv[2] ?? 4317));
  console.log(`${url}/examples/   the meadow, live — drag to turn it`);
}
