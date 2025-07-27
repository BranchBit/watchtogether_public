const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { spawnTorrentServer } = require("./torrent-server");
const WebSocket = require("ws");
const localtunnel = require("localtunnel");

function encodeInviteURL(url) {
  return Buffer.from(url).toString("base64url");
}

function decodeInviteCode(code) {
  try {
    return Buffer.from(code, "base64url").toString();
  } catch {
    return null;
  }
}

let win;
let wss = null;

function createWindow() {
  win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  });
  win.loadFile("index.html");
}

app.whenReady().then(createWindow);

ipcMain.on("start-host", async (event, { magnetURI }) => {
  const getPort = (await import("get-port")).default;

  const port = await getPort();
  startWebSocketServer(port);
  const tunnel = await localtunnel({ port });
  const tunnelURL = tunnel.url.replace("https", "wss").replace("http", "ws");

  win.webContents.send("start-socket", tunnelURL);

  console.log("🌍 Tunnel URL created:", tunnelURL);

  const inviteCode = encodeInviteURL(tunnelURL);
  win.webContents.send("tunnel-url", {
    raw: tunnelURL,
    inviteCode,
  });

  const torrentPort = await getPort();
  const { fileName, torrent } = await spawnTorrentServer(
    magnetURI,
    torrentPort,
  );
  const streamURL = `http://localhost:${torrentPort}/video`;

  torrent.on("download", () => updateTorrent(torrent, fileName));
  torrent.on("done", () => updateTorrent(torrent, fileName));

  win.webContents.send("torrent-loaded", { publicStreamURL: streamURL });

  setInterval(() => {
    const syncPayload = {
      type: "sync",
      magnet: magnetURI,
    };
    win.webContents.send("sync-update", syncPayload);
    broadcastSync(syncPayload);
  }, 1000);

  function updateTorrent(t, fileName) {
    win.webContents.send("torrent-update", {
      progress: t.progress,
      numPeers: t.numPeers,
      downloadSpeed: t.downloadSpeed,
      fileName,
      fileSize: t.length,
    });
  }
});

let clientJoined = false;
ipcMain.on("join-room", async (event, code) => {
  const socketURL = decodeInviteCode(code);
  if (!socketURL || !socketURL.startsWith("ws")) {
    console.warn("Invalid invite code");
    return win.webContents.send("status", "Invalid invite code");
  }

  const { connectToRoom } = require("./sync-socket");

  win.webContents.send("start-socket", socketURL);

  connectToRoom(socketURL, async (sync) => {
    console.log("🎯 Received sync payload:", sync);
    if (!sync.magnet) return console.warn("No magnet URI received");
    if (clientJoined) return;

    clientJoined = true;

    const getPort = (await import("get-port")).default;
    const torrentPort = await getPort();
    const { fileName, torrent } = await spawnTorrentServer(
      sync.magnet,
      torrentPort,
    );
    win.webContents.send("torrent-loaded", {
      publicStreamURL: `http://localhost:${torrentPort}/video`,
    });

// Add torrent event listeners for progress updates
    torrent.on("download", () => updateTorrent(torrent, fileName));
    torrent.on("done", () => updateTorrent(torrent, fileName));

    function updateTorrent(t, fileName) {
      win.webContents.send("torrent-update", {
        progress: t.progress,
        numPeers: t.numPeers,
        downloadSpeed: t.downloadSpeed,
        fileName,
        fileSize: t.length,
      });
    }

    win.webContents.send("sync-update", sync);
  });
});

function startWebSocketServer(port) {
  wss = new WebSocket.Server({ port });
  let state = {};
  wss.on("connection", (ws) => {
    console.log("🔌 Client connected to local host socket");
    ws.on("message", (msg) => {
      console.log("📩 Host socket received:", msg);
      let data;
      try {
        data = JSON.parse(msg);
      } catch {
        console.log("invalid json !!!");
        return;
      }
      if (data.type === "init") state = { magnet: data.magnet };
      if (data.type === "sync") {
        state = { ...state, ...data };
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(state));
          }
        });
      }
    });
  });
}

function broadcastSync(payload) {
  if (!wss) return;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  });
}
