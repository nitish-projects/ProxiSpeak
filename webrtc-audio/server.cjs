const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Server } = require("socket.io");

// Temporary local exercise settings.
const OFFICE_ID = "local-audio-lab";
const HEARING_RADIUS = 100;
const MAP_MIN = 0;
const MAP_MAX = 1000;
const MAX_PEERS = 2;

const peers = new Map();
let proximityRevision = 0;

// Only these files can be served.
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/client.js", ["client.js", "application/javascript"]],
  ["/spatial-math.js", ["spatial-math.js", "application/javascript"]],
]);

const server = http.createServer((req, res) => {
  const pathname = (req.url || "/").split("?")[0];
  const file = files.get(pathname);

  if (!file) {
    res.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end("Not found");
    return;
  }

  fs.readFile(path.join(__dirname, file[0]), (error, content) => {
    if (error) {
      console.error(`Could not load ${file[0]}:`, error.message);

      res.writeHead(500, {
        "Content-Type": "text/plain; charset=utf-8",
      });
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

function isValidPosition(position) {
  return (
    Array.isArray(position) &&
    position.length === 2 &&
    position.every(
      (coordinate) =>
        Number.isFinite(coordinate) &&
        coordinate >= MAP_MIN &&
        coordinate <= MAP_MAX
    )
  );
}

// Each browser receives its own position and a complete list
// of the other browsers currently within its hearing radius.
function sendProximitySnapshots() {
  const revision = ++proximityRevision;

  for (const viewer of peers.values()) {
    const nearbyUsers = [...peers.values()]
      .filter((other) => {
        if (other.socket.id === viewer.socket.id) return false;

        const dx = other.position[0] - viewer.position[0];
        const dy = other.position[1] - viewer.position[1];

        return Math.hypot(dx, dy) < HEARING_RADIUS;
      })
      .map((other) => ({
        // Demo identity: socket IDs are not authenticated account IDs.
        userId: other.socket.id,
        peerId: other.socket.id,
        position: [...other.position],
        audioReady: other.ready,
      }));

    viewer.socket.emit("proximity:update", {
      roomId: OFFICE_ID,
      hearingRadius: HEARING_RADIUS,
      revision,

      self: {
        userId: viewer.socket.id,
        peerId: viewer.socket.id,
        position: [...viewer.position],
      },

      // Send an empty array when nobody is nearby.
      nearbyUsers,
    });
  }
}

function pairReadyPeers() {
  const waiting = [...peers.values()]
    .filter((peer) => peer.ready && !peer.callId)
    .sort((a, b) => a.socket.id.localeCompare(b.socket.id));

  if (waiting.length !== 2) return;

  const [first, second] = waiting;
  const callId = randomUUID();

  // Set both participants' state before notifying either browser.
  first.callId = callId;
  first.otherId = second.socket.id;

  second.callId = callId;
  second.otherId = first.socket.id;

  for (const [peer, other] of [
    [first, second],
    [second, first],
  ]) {
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
  // This exercise supports two browser sessions.
  if (peers.size >= MAX_PEERS) {
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
    position: peers.size === 0 ? [50, 40] : [80, 40],
  };

  peers.set(socket.id, peer);
  console.log("Connected:", socket.id);

  // Client asks for the current proximity state.
  socket.on("proximity:request", () => {
    sendProximitySnapshots();
  });

  // Client submits its own avatar position.
  // Identity comes from this socket, not a client-supplied user ID.
  socket.on("avatar:position", (message, reply) => {
    if (typeof reply !== "function") return;

    if (message?.roomId !== OFFICE_ID) {
      reply({
        ok: false,
        message: "Invalid room.",
      });
      return;
    }

    if (!isValidPosition(message.position)) {
      reply({
        ok: false,
        message:
          `Position must contain two numbers between ${MAP_MIN} and ${MAP_MAX}.`,
      });
      return;
    }

    peer.position = [...message.position];

    reply({ ok: true });
    sendProximitySnapshots();
  });

  socket.on("audio:ready", (reply) => {
    if (typeof reply !== "function") return;

    peer.ready = true;

    reply({ ok: true });
    pairReadyPeers();
    sendProximitySnapshots();
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
        peer.ready &&
        peer.callId &&
        message.callId === peer.callId &&
        message.toPeerId === peer.otherId &&
        target &&
        target.ready &&
        target.callId === peer.callId &&
        target.otherId === socket.id;

      if (!validSession) {
        reply({
          ok: false,
          message: "Call is no longer available.",
        });
        return;
      }

      let payload;

      if (eventName === "webrtc:ice-candidate") {
        const candidate = message.candidate;

        if (!candidate || typeof candidate.candidate !== "string") {
          reply({
            ok: false,
            message: "Invalid ICE candidate.",
          });
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
          reply({
            ok: false,
            message: "Invalid session description.",
          });
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
    sendProximitySnapshots();
  });

  socket.on("disconnect", () => {
    endSession(peer, "A participant disconnected.");
    peers.delete(socket.id);

    sendProximitySnapshots();
    console.log("Disconnected:", socket.id);
  });

  // Notify both browsers when a new participant joins.
  sendProximitySnapshots();
});

server.on("error", (error) => {
  console.error("Server error:", error.message);
});

server.listen(3000, "127.0.0.1", () => {
  console.log("Open http://127.0.0.1:3000 in TWO tabs.");
  console.log(`Room: ${OFFICE_ID}`);
  console.log(`Hearing radius: ${HEARING_RADIUS} map units.`);
});