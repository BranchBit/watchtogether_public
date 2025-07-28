const WebSocket = require("ws");

let socket = null;

function connectToRoom(socketURL, onSync, onError) {
  socket = new WebSocket(socketURL);

  socket.on("open", () => {
    console.log("✅ Connected to:", socketURL);
    socket.send(JSON.stringify({ type: "init" }));
  });

  socket.on("message", (msg) => {
    console.log("📥 Message received:", msg);
    try {
      const data = JSON.parse(msg);
      if (data.type === "sync") {
        console.log("🎯 Received sync:", data);
        onSync(data);
      }
    } catch (e) {
      console.error("❌ Parse error:", e);
    }
  });

  socket.on("close", () => {
    console.log("❌ Socket closed");
    if (onError) onError("Connection to room was closed.");
  });

  socket.on("error", (err) => {
    console.error("🚨 WebSocket error:", err.message);
    if (onError) onError("Could not connect to the room.");
  });
}

module.exports = { connectToRoom };
