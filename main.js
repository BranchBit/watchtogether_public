const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { spawnTorrentServer } = require("./torrent-server");
const WebSocket = require("ws");
const localtunnel = require("localtunnel");
const MPV = require("node-mpv");


const { execFile } = require("child_process");

function checkMPVInstalled() {
  return new Promise((resolve, reject) => {
    execFile("mpv", ["--version"], (error, stdout, stderr) => {
      if (error) {
        reject(new Error("MPV is not installed or not in PATH, dl from https://github.com/zhongfly/mpv-winbuild/releases"));
      } else {
        resolve(true);
      }
    });
  });
}


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

app.whenReady().then(async () => {
  try {
    await checkMPVInstalled();
    createWindow();
  }catch (err) {
    console.error("❌", err.message);
    const { BrowserWindow } = require("electron");

    const errorWin = new BrowserWindow({
      width: 500,
      height: 300,
      title: "MPV Player Not Found",
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        contextIsolation: true,
      },
    });

    errorWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`
    <body style="font-family:sans-serif;background:#111;color:#fff;padding:20px;">
      <h2>MPV Player Not Found</h2>
      <p>The MPV media player is required to run this app.</p>
      <p>Please install it and make sure it's in your system PATH.</p>
      <p>
        <a href="https://github.com/zhongfly/mpv-winbuild/releases"
           target="_blank"
           style="color:#8f8;">Download and install MPV</a>
      </p>
    </body>
  `));

    errorWin.on("closed", () => {
      app.quit();
    });
  }
});

ipcMain.on("start-host", async (event, { magnetURI }) => {
  const getPort = (await import("get-port")).default;

  const port = await getPort();
  startWebSocketServer(port);
  const tunnel = await localtunnel({ port });
  const tunnelURL = tunnel.url.replace("https", "wss").replace("http", "ws");

  win.webContents.send("start-socket", tunnelURL);
  const inviteCode = encodeInviteURL(tunnelURL);
  win.webContents.send("tunnel-url", {
    raw: tunnelURL,
    inviteCode,
  });

  const torrentPort = await getPort();
  const { fileName, torrent } = await spawnTorrentServer(magnetURI, torrentPort);
  const streamURL = `http://localhost:${torrentPort}/video`;

  torrent.on("download", () => updateTorrent(torrent, fileName));
  torrent.on("done", () => updateTorrent(torrent, fileName));

  const hostPlayer = new MPV({
    audio_only: false,
    debug: false,
    args: ["--force-window=yes", "--idle=yes"],
  });

  setTimeout(async () => {
    try {
      await hostPlayer.load(streamURL);
      await hostPlayer.play();
      console.log("🎬 Host MPV started playback.");
    } catch (err) {
      console.error("❌ Host MPV failed to start:", err);
    }
  }, 2000); // small delay to ensure stream is up

  setInterval(() => {
    hostPlayer.getProperty("time-pos")
        .then((time) => {
          const syncPayload = {
            type: "sync",
            magnet: magnetURI,
            time: time !== undefined ? parseFloat(time.toFixed(2)) : 0,
          };
          console.log("📡 Broadcasting sync:", syncPayload);
          win.webContents.send("sync-update", syncPayload);
          broadcastSync(syncPayload);
        })
        .catch((err) => console.error("MPV time-pos read error (host):", err));
  }, 2000);

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
    return win.webContents.send("status", "Invalid invite code");
  }

  const { connectToRoom } = require("./sync-socket");
  win.webContents.send("start-socket", socketURL);

    let latestSync = {};
    connectToRoom(socketURL, async (sync) => {
    latestSync = sync; // 🔥 Keep latest sync object up to date    if (!sync.magnet) return;
    if (clientJoined) return;
    clientJoined = true;

    const getPort = (await import("get-port")).default;
    const torrentPort = await getPort();
    const { fileName, torrent } = await spawnTorrentServer(sync.magnet, torrentPort);
    const streamURL = `http://localhost:${torrentPort}/video`;

    torrent.on("download", () => updateTorrent(torrent, fileName));
    torrent.on("done", () => updateTorrent(torrent, fileName));

    const clientPlayer = new MPV({
      audio_only: false,
      debug: false,
      args: ["--force-window=yes", "--idle=yes"],
    });

    setTimeout(async () => {
      try {
        await clientPlayer.load(streamURL);
        await clientPlayer.play();
        console.log("🎬 Client MPV started playback.");
      } catch (err) {
        console.error("❌ Client MPV failed to start:", err);
      }
    }, 2000); // small delay to ensure stream is up

    setInterval(() => {
      clientPlayer.getProperty("time-pos")
          .then((currentTime) => {
            if (
                typeof currentTime === "number" &&
                Math.abs(currentTime - (latestSync.time || 0)) > 2
            ) {
              console.log("🔁 Desync detected, correcting...");
              clientPlayer.goToPosition(latestSync.time);
            }
          })
          .catch((err) => console.error("MPV sync error (client):", err));
    }, 2000);

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
      let data;
      try {
        data = JSON.parse(msg);
      } catch {
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

