import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 3000 });

const clients = new Map();

wss.on("connection", (ws, req) => {
  const userId = new URL(req.url, "http://localhost").searchParams.get(
    "userId",
  );
  ws.userId = userId;
  console.log("Connected:", userId);
  clients.set(ws, userId);

  for (const [otherWs, otherUserId] of clients.entries()) {
    if (otherWs !== ws && otherWs.readyState === WebSocket.OPEN) {
      otherWs.send(
        JSON.stringify({
          type: "userJoined",
          userId: userId,
        }),
      );
    }
  }

  // 接続してきたクライアントに既存のユーザーを教える
  const existingUserIds = [...clients.values()].filter((id) => id !== userId);
  ws.send(
    JSON.stringify({
      type: "existingUsers",
      existingUserIds,
    }),
  );

  ws.on("close", () => {
    clients.delete(ws);
    // 他のクライアントに通知
    for (const [otherWs] of clients.entries()) {
      if (otherWs.readyState === WebSocket.OPEN) {
        otherWs.send(
          JSON.stringify({
            type: "userLeft",
            userId: userId,
          }),
        );
      }
    }
  });

  ws.on("message", (msg, isBinary) => {
    if (isBinary) {
      sendBinary(msg, ws);
    } else {
      const data = JSON.parse(msg.toString());

      if (data.type === "motion") {
        sendMessage(msg, ws);
      }

      if (data.type === "requestVrm") {
        sendMessage(
          JSON.stringify({ type: "sendVrmTo", targetId: data.requestFrom }),
          ws,
          data.requestTo,
        );
      }
    }
  });
});

const sendBinary = (msg, ws) => {
  const buffer = new Uint8Array(msg);
  const headerLength = new DataView(buffer.buffer).getUint32(0, true);
  const headerBytes = buffer.slice(4, 4 + headerLength);
  const header = JSON.parse(new TextDecoder().decode(headerBytes));

  sendMessage(msg, ws, header.targetId);
};

const sendMessage = (data, except, targetId) => {
  wss.clients.forEach((client) => {
    if (targetId) {
      if (client.userId === targetId && client.readyState === 1) {
        client.send(data);
      }
    } else {
      if (client !== except && client.readyState === 1) {
        client.send(data);
      }
    }
  });
};
