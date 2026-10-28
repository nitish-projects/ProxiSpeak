
const { io } = require("socket.io-client");

const socket = io("http://localhost:5000");

socket.on("connect", () => {
  console.log("Second user connected:", socket.id);
  socket.emit("join-office", "office-1");
});

socket.on("office-joined", (data) => {
  console.log(data.message);
  socket.emit("get-positions", "office-1");
});

socket.on("existing-users", (users) => {
  console.log("Users already in office:", users);
});

socket.on("avatar-moved", (data) => {
  console.log("Another user's movement:", data);
});

socket.on("error-message", (data) => {
  console.log("Error:", data.message);
});
socket.on("user-left", (data) => {
  console.log("User left the office:", data.userId);
});
socket.on("positions-list", (positions) => {
  console.log("Current positions:", positions);
});