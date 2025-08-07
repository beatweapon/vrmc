import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 3000 });

const clients = new Map();

const broadcast = (data, except) => {
  wss.clients.forEach((client) => {
    if (client !== except && client.readyState === 1) {
      client.send(data);
    }
  });
};

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
      // VRMチャンクはそのまま他のクライアントに転送
      broadcast(msg, ws);
    } else {
      const data = JSON.parse(msg.toString());

      if (data.type === "motion") {
        broadcast(msg, ws);
      }

      if (data.type === "requestVrm") {
        // 特定の相手にVRM送ってと依頼
        wss.clients.forEach((client) => {
          if (client.userId === data.id) {
            client.send(
              JSON.stringify({ type: "sendVrmTo", targetId: userId }),
            );
          }
        });
      }

      if (data.type === "requestAllVrms") {
        // 全員にVRM送ってと依頼
        wss.clients.forEach((client) => {
          if (client.userId && client.userId !== userId) {
            client.send(
              JSON.stringify({ type: "sendVrmTo", targetId: userId }),
            );
          }
        });
      }
    }
  });
});
