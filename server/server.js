import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  console.log("a user connected:", socket.id);

  socket.on("motion", (data) => {
    socket.broadcast.emit("motion", data);
  });

  socket.on("disconnect", () => {
    console.log("user disconnected:", socket.id);
  });
});

httpServer.listen(3000, () => {
  console.log("Server listening on http://localhost:3000");
});
