import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 3001 });

function broadcast(data, except) {
  wss.clients.forEach((client) => {
    if (client !== except && client.readyState === 1) {
      client.send(data);
    }
  });
}

wss.on("connection", (ws, req) => {
  const userId = new URL(req.url, "http://localhost").searchParams.get(
    "userId",
  );
  ws.userId = userId;
  console.log("Connected:", userId);

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
