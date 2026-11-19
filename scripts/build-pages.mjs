import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { browserFiles } from "./browser-files.mjs";

function roomApiOrigin(value) {
  if (!value) return "";
  const url = URL.parse(value);
  if (!url || url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("HEXACHESS_API_URL must be an HTTPS origin, such as https://hexachess-api.example.com.");
  }
  return url.origin;
}

const api = roomApiOrigin(process.env.HEXACHESS_API_URL?.trim());
const source = new URL("../dist/", import.meta.url);
const output = new URL("../dist-pages/", import.meta.url);
const html = await readFile(new URL("index.html", source), "utf8");
const configured = html.replace("</head>", `  <meta name="hexachess-room-api" content="${api}">\n</head>`);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all([
  ...browserFiles.filter(file => file !== "index.html").map(file =>
    copyFile(new URL(file, source), new URL(file, output))
  ),
  writeFile(new URL("index.html", output), configured),
  writeFile(new URL(".nojekyll", output), ""),
]);
console.log(`Built dist-pages (${api ? "online rooms enabled" : "local play"}).`);
