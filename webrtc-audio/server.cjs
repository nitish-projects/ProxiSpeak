const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const pagePath = path.join(__dirname, "index.html");

const server = http.createServer((req, res) => {
  if (req.url !== "/" && req.url !== "/index.html") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  fs.readFile(pagePath, (error, content) => {
    if (error) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Could not load index.html");
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });

    res.end(content);
  });
});

server.on("error", (error) => {
  console.error("Server error:", error.message);
});

server.listen(3000, "127.0.0.1", () => {
  console.log("Open http://127.0.0.1:3000");
});