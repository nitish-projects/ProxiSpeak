const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Server } = require("socket.io");

const OFFICE_ID = "local-audio-lab";
const peers = new Map();

const files = {
  "/": ["index.html", "text/html"],
  "/index.html": ["index.html", "text/html"],
  "/client.js": ["client.js", "application/javascript"],
};

const server = http.createServer((req, res) => {
  const file = files[req.url];

  if (!file) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  fs.readFile(path.join(__dirname, file[0]), (error, content) => {
    if (error) {
      res.writeHead(500);
      res.end("Could not load file");
      return;
    }

    res.writeHead(200, {
      "Content-Type": `${file[1]}; charset=utf-8`,
      "Cache-Control": "no-store",
    });

    res.end(content);
  });
});

const io = new Server(server, {
  maxHttpBufferSize: 100_000,
});

function pairReadyPeers() {
  const waiting = [...peers.values()]
    .filter((peer) => peer.ready && !peer.callId)
    .sort((a, b) => a.socket.id.localeCompare(b.socket.id));

  if (waiting.length !== 2) return;

  const [first, second] = waiting;
  const callId = randomUUID();

  for (const [peer, other] of [
    [first, second],
    [second, first],
  ]) {
    peer.callId = callId;
    peer.otherId = other.socket.id;

    peer.socket.emit("webrtc:start", {
      officeId: OFFICE_ID,
      callId,
      peerId: other.socket.id,
      initiator: peer === first,
    });
  }
}

function endSession(peer, reason) {
  const callId = peer.callId;
  const other = peers.get(peer.otherId);

  const affected = [peer];

  if (other && callId && other.callId === callId) {
    affected.push(other);
  }

  for (const member of affected) {
    member.ready = false;
    member.callId = null;
    member.otherId = null;

    member.socket.emit("webrtc:end", {
      callId,
      reason,
    });
  }
}

io.on("connection", (socket) => {
  // This local exercise admits only two browser sessions.
  if (peers.size >= 2) {
    socket.emit("lab:full", {
      message: "Two tabs are already connected. Close an extra tab.",
    });

    socket.disconnect(true);
    return;
  }

  const peer = {
    socket,
    ready: false,
    callId: null,
    otherId: null,
  };

  peers.set(socket.id, peer);
  console.log("Connected:", socket.id);

  socket.on("audio:ready", (reply) => {
    if (typeof reply !== "function") return;

    peer.ready = true;
    reply({ ok: true });
    pairReadyPeers();
  });

  for (const eventName of [
    "webrtc:offer",
    "webrtc:answer",
    "webrtc:ice-candidate",
  ]) {
    socket.on(eventName, (message, reply) => {
      if (typeof reply !== "function") return;

      const target = peers.get(peer.otherId);

      const validSession =
        message &&
        message.officeId === OFFICE_ID &&
        peer.callId &&
        message.callId === peer.callId &&
        message.toPeerId === peer.otherId &&
        target &&
        target.callId === peer.callId;

      if (!validSession) {
        reply({ ok: false, message: "Call is no longer available." });
        return;
      }

      let payload;

      if (eventName === "webrtc:ice-candidate") {
        const candidate = message.candidate;

        if (!candidate || typeof candidate.candidate !== "string") {
          reply({ ok: false, message: "Invalid ICE candidate." });
          return;
        }

        payload = { candidate };
      } else {
        const expectedType =
          eventName === "webrtc:offer" ? "offer" : "answer";

        const description = message.description;

        if (
          description?.type !== expectedType ||
          typeof description.sdp !== "string"
        ) {
          reply({ ok: false, message: "Invalid session description." });
          return;
        }

        payload = { description };
      }

      target.socket.emit(eventName, {
        officeId: OFFICE_ID,
        fromPeerId: socket.id,
        callId: peer.callId,
        ...payload,
      });

      reply({ ok: true });
    });
  }

  socket.on("audio:leave", () => {
    endSession(peer, "A participant ended the session.");
  });

  socket.on("disconnect", () => {
    endSession(peer, "A participant disconnected.");
    peers.delete(socket.id);
    console.log("Disconnected:", socket.id);
  });
});

server.on("error", (error) => {
  console.error("Server error:", error.message);
});

server.listen(3000, "127.0.0.1", () => {
  console.log("Open http://127.0.0.1:3000 in TWO tabs.");
});