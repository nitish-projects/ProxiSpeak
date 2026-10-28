
const { io } = require("socket.io-client");

const socket = io("http://localhost:5000");

socket.on("connect", () => {
  console.log("Connected:", socket.id);
  socket.emit("join-office", "office-1");
});

socket.on("office-joined", (data) => {
  console.log("Office joined:", data);

  socket.emit("move-avatar", {
    officeId: "office-1",
    x: 120,
    y: 80
  });
});

socket.on("avatar-moved", (data) => {
  console.log("Avatar moved:", data);
});

socket.on("error-message", (data) => {
  console.log("Error:", data);
});
