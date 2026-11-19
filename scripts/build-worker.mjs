import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { browserFiles } from "./browser-files.mjs";

const project = new URL("../", import.meta.url);
const dist = new URL("dist/", project);
const MIME = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
};
const assets = Object.fromEntries(await Promise.all(browserFiles.map(async file => [
  "/" + file,
  { content: await readFile(new URL(file, dist), "utf8"), type: MIME[file.split(".").at(-1)] },
])));

const source = `
import { handleRoomRequest } from "./server/cors.mjs";

const assets = ${JSON.stringify(assets)};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/rooms" || pathname.startsWith("/api/rooms/")) {
      return handleRoomRequest(request, env);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const path = pathname === "/" ? "/index.html" : pathname;
    if (!Object.hasOwn(assets, path)) return new Response("Not found", { status: 404 });
    const { content, type } = assets[path];
    return new Response(request.method === "HEAD" ? null : content, {
      headers: {
        "Content-Type": type,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
      },
    });
  },
};
`;

await build({
  stdin: { contents: source, resolveDir: fileURLToPath(project), sourcefile: "worker-entry.js" },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: fileURLToPath(new URL("server/index.js", dist)),
});
const hosting = await readFile(new URL(".openai/hosting.json", project)).catch(error => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (hosting) {
  await mkdir(new URL(".openai/", dist), { recursive: true });
  await writeFile(new URL(".openai/hosting.json", dist), hosting);
  await cp(new URL("drizzle/", project), new URL(".openai/drizzle/", dist), { recursive: true });
}
