import { WebSocketServer } from "ws";

const motionWss = new WebSocketServer({ port: 3001 });
const avatarWss = new WebSocketServer({ port: 3002 });

const vrmStore = {}; // { userId: [ArrayBuffer, ...] }

function broadcast(wss, data, except) {
  wss.clients.forEach((client) => {
    if (client !== except && client.readyState === 1) {
      client.send(data);
    }
  });
}

// ===== モーション同期 =====
motionWss.on("connection", (ws, req) => {
  const userId = new URL(req.url, "http://localhost").searchParams.get(
    "userId",
  );
  ws.userId = userId;
  console.log("Motion connected:", userId);

  ws.on("message", (msg) => {
    // モーションはJSON前提
    broadcast(motionWss, msg, ws);
  });
});

// ===== VRM送受信 =====
avatarWss.on("connection", (ws, req) => {
  const userId = new URL(req.url, "http://localhost").searchParams.get(
    "userId",
  );
  ws.userId = userId;
  console.log("Avatar connected:", userId);

  ws.on("message", (msg) => {
    if (Buffer.isBuffer(msg)) {
      // バイナリチャンク受信
      const jsonLen = msg.readUInt16BE(0);
      const json = JSON.parse(msg.slice(2, 2 + jsonLen).toString());
      const chunk = msg.slice(2 + jsonLen);

      if (!vrmStore[json.id]) vrmStore[json.id] = [];
      vrmStore[json.id].push(chunk);

      if (json.isLast) {
        console.log(`VRM fully received for ${json.id}`);
      }
      // 他の参加者に転送
      broadcast(avatarWss, msg, ws);
    } else {
      // テキストメッセージ
      const data = JSON.parse(msg.toString());
      if (data.type === "requestVrm") {
        // 保持しているVRMを送信
        const chunks = vrmStore[data.id];
        if (chunks) {
          chunks.forEach((c, i) => {
            const meta = { id: data.id, isLast: i === chunks.length - 1 };
            const metaBuf = Buffer.from(JSON.stringify(meta));
            const lenBuf = Buffer.alloc(2);
            lenBuf.writeUInt16BE(metaBuf.length);
            ws.send(Buffer.concat([lenBuf, metaBuf, c]));
          });
        }
      }
    }
  });
});
