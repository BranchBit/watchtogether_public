const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { spawnTorrentServer } = require("./torrent-server");
const WebSocket = require("ws");
const localtunnel = require("localtunnel");
const MPV = require("node-mpv");
const { execFile } = require("child_process");
const os = require("os");
const { spawn } = require("child_process");
const fs = require("fs");

function checkMPVInstalled() {
  return new Promise((resolve, reject) => {
    execFile("mpv", ["--version"], (error) => {
      if (error) {
        reject(new Error("MPV is not installed or not in PATH"));
      } else {
        resolve(true);
      }
    });
  });
}

function getMPVErrorMessage(platform) {
  switch (platform) {
    case "win32":
      return `
        <h2>MPV Not Found (Windows)</h2>
        <p>This app needs MPV media player installed and available in your PATH.</p>
        <p><strong>Recommended:</strong></p>
        <ul>
          <li><a href="https://github.com/zhongfly/mpv-winbuild/releases/download/2025-07-28-a6f3236/mpv-x86_64-20250728-git-a6f3236.7z" style="color:#8f8;" target="_blank">Download mpv-winbuild, unzip and run installer</a></li>
        </ul>
        <p>After installing, restart this app.</p>
      `;

    case "darwin":
      return `
        <h2>MPV Not Found (macOS)</h2>
        <p>This app requires MPV to be installed.</p>
        <ul>
          <li><a href="https://github.com/mpv-player/mpv/releases/latest" style="color:#8f8;" target="_blank">Download latest MPV for macOS</a></li>
          <li>Or install via Homebrew: <code>brew install mpv</code></li>
        </ul>
        <p>After installing, restart this app.</p>
      `;

    case "linux":
      return `
        <h2>MPV Not Found (Linux)</h2>
        <p>This app requires MPV installed and accessible via PATH.</p>
        <p>Use your distro’s package manager:</p>
        <ul>
          <li>Debian/Ubuntu: <code>sudo apt install mpv</code></li>
          <li>Fedora: <code>sudo dnf install mpv</code></li>
          <li>Arch: <code>sudo pacman -S mpv</code></li>
        </ul>
        <p>After installing, restart this app.</p>
      `;

    default:
      return `
        <h2>MPV Not Found (Unknown Platform)</h2>
        <p>This app requires the MPV media player.</p>
        <p><a href="https://mpv.io/" style="color:#8f8;" target="_blank">Visit mpv.io for instructions</a></p>
        <p>After installing, restart this app.</p>
      `;
  }
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
  } catch (err) {
    console.error("❌", err.message);
    const platform = os.platform();
    const message = getMPVErrorMessage(platform);

    const errorWin = new BrowserWindow({
      width: 600,
      height: 400,
      title: "MPV Player Not Found",
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
      },
    });

    ipcMain.handle("install-mpv", async (event) => {
      const batPath = path.join(__dirname, "assets", "install-mpv.bat");

      const proc = spawn("cmd.exe", ["/c", batPath]);

      proc.stdout.on("data", (data) => {
        errorWin.webContents.send("installer-log", data.toString());
      });

      proc.stderr.on("data", (data) => {
        errorWin.webContents.send("installer-log", "ERROR: " + data.toString());
      });

      proc.on("exit", (code) => {
        errorWin.webContents.send("installer-log", `\nInstaller exited with code ${code}\nRestart the app to try again.`);
      });
    });

    errorWin.loadFile("mpv-error.html");
    errorWin.webContents.openDevTools();

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
  }, 2000);

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

  connectToRoom(
      socketURL,
      async (sync) => {
        latestSync = sync;
        if (!sync.magnet || clientJoined) return;
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
        }, 2000);

        setInterval(() => {
          clientPlayer.getProperty("time-pos")
              .then((currentTime) => {
                if (typeof currentTime === "number" && Math.abs(currentTime - (latestSync.time || 0)) > 2) {
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
      },
      (errMsg) => {
        // New: notify user of error in UI
        console.error("Room join error:", errMsg);
        clientJoined = false;
        win.webContents.send("status", errMsg);
      }
  );
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
