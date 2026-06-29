const http = require("http");
const fs = require("fs");
const path = require("path");
const { handler } = require("./api/index.js");

const PORT = Number(process.env.PORT || 5173);
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const filePath = urlPath === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden");
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return send(res, 404, "Not found");
  res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) return handler(req, res);
  serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`OPOWEB listo en http://localhost:${PORT}`);
});
