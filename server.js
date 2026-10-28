
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    message: "ProxiSpeak backend is running!"
  });
});

// Stores each connected user's latest position.
const userPositions = new Map();

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-office", async (officeId) => {
    if (typeof officeId !== "string" || !officeId.trim()) {
      socket.emit("error-message", {
        message: "A valid office ID is required."
      });
      return;
    }

    officeId = officeId.trim();

    try {
      await socket.join(officeId);

      console.log("Rooms after joining:", [...socket.rooms]);

      const existingUsers = [];

      for (const [userId, position] of userPositions.entries()) {
        if (
          position.officeId === officeId &&
          userId !== socket.id
        ) {
          existingUsers.push({
            userId,
            x: position.x,
            y: position.y
          });
        }
      }

      socket.emit("existing-users", existingUsers);

      socket.emit("office-joined", {
        officeId,
        message: "Successfully joined the office!"
      });

      console.log(`${socket.id} joined office ${officeId}`);
    } catch (error) {
      console.error("Join office failed:", error);

      socket.emit("error-message", {
        message: "Could not join the office."
      });
    }
  });

  socket.on("move-avatar", (position) => {
    const { officeId, x, y } = position || {};

    console.log("Move request:", { officeId, x, y });
    console.log("Current rooms:", [...socket.rooms]);

    if (
      typeof officeId !== "string" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0
    ) {
      socket.emit("error-message", {
        message: "Invalid avatar position."
      });
      return;
    }

    if (!socket.rooms.has(officeId)) {
      console.log("Room membership failed:", officeId);

      socket.emit("error-message", {
        message: "You must join this office before moving."
      });
      return;
    }

    userPositions.set(socket.id, { officeId, x, y });

    socket.to(officeId).emit("avatar-moved", {
      userId: socket.id,
      x,
      y
    });

    console.log(`Avatar ${socket.id} moved to (${x}, ${y})`);
  });

  socket.on("get-positions", (officeId) => {
    if (
      typeof officeId !== "string" ||
      !socket.rooms.has(officeId)
    ) {
      socket.emit("error-message", {
        message: "You must join the office to view its positions."
      });
      return;
    }

    const positions = [];

    for (const [userId, position] of userPositions.entries()) {
      if (position.officeId === officeId) {
        positions.push({
          userId,
          officeId: position.officeId,
          x: position.x,
          y: position.y
        });
      }
    }

    socket.emit("positions-list", positions);
  });

  socket.on("disconnect", () => {
    const position = userPositions.get(socket.id);

    if (position) {
      socket.to(position.officeId).emit("user-left", {
        userId: socket.id
      });
    }

    userPositions.delete(socket.id);

    console.log("User disconnected:", socket.id);
  });
});

const PORT = 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
