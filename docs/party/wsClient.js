// const SERVER_URL = "ws://localhost:3000";
const SERVER_URL = "wss://222557efe84b.ngrok-free.app";

export const connectWebSocket = (userId, handlers) => {
  let ws;
  const init = () => {
    ws = new WebSocket(`${SERVER_URL}?userId=${userId}`);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      console.log("Connected");
      ws.send(JSON.stringify({ type: "requestAllVrms" }));
    };

    ws.onmessage = async (e) => {
      if (e.data instanceof ArrayBuffer) {
        // VRM受信処理
        const buffer = new Uint8Array(e.data);

        // 最初の4バイトでヘッダーの長さを読む
        const headerLength = new DataView(buffer.buffer).getUint32(0, true);
        const headerBytes = buffer.slice(4, 4 + headerLength);
        const bodyBytes = buffer.slice(4 + headerLength);

        const decoder = new TextDecoder();
        const headerJson = decoder.decode(headerBytes);
        const header = JSON.parse(headerJson);

        if (header.type === "vrmData") {
          const { senderId, targetId } = header;
          // ここで senderId を使って処理
          handlers.onReceiveVrm?.(senderId, bodyBytes.buffer);
        }
      } else {
        const msg = JSON.parse(e.data);
        if (msg.type === "existingUsers") {
          handlers.onJoin?.(msg);
        }
        if (msg.type === "userJoined") {
          // 新規ユーザー参加
          handlers.onUserJoined?.(msg);
        }
        if (msg.type === "motion" && msg.userId !== userId) {
          // 他人のモーション更新
          handlers.onReceiveMotion?.(msg);
        }
        if (msg.type === "sendVrmTo" && msg.targetId === userId) {
          // 自分のVRM送信
          handlers.onRequestMyVrm?.(msg);
        }
      }
    };
  };
  init();

  return {
    sendMotion: (faceData) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "motion", userId, data: faceData }));
      }
    },
    sendVrm: (targetId, senderId, arrayBuffer) => {
      const headerObj = {
        type: "vrmData",
        senderId,
        targetId,
      };
      const headerJson = JSON.stringify(headerObj);
      const encoder = new TextEncoder();
      const headerBytes = encoder.encode(headerJson);
      const headerLength = headerBytes.length;

      // 4バイトでヘッダーの長さを表す（先頭に付加）
      const headerLengthBuffer = new Uint32Array([headerLength]).buffer;

      const finalBuffer = new Uint8Array(
        4 + headerLength + arrayBuffer.byteLength,
      );
      finalBuffer.set(new Uint8Array(headerLengthBuffer), 0);
      finalBuffer.set(headerBytes, 4);
      finalBuffer.set(new Uint8Array(arrayBuffer), 4 + headerLength);

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(finalBuffer);
      }
    },
  };
};
