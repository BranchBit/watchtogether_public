// main.js — Cleaned up and fixed MPV auto-download and extract via copied archive
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { spawnTorrentServer } = require("./torrent-server");
const WebSocket = require("ws");
const localtunnel = require("localtunnel");
const MPV = require("node-mpv");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const https = require("https");
const os = require("os");

let win;
let wss = null;

function checkMPVInstalled() {
  return new Promise((resolve, reject) => {
    execFile("mpv", ["--version"], (error) => {
      if (error) reject(new Error("MPV is not installed or not in PATH"));
      else resolve(true);
    });
  });
}

function getMPVErrorMessage(platform) {
  switch (platform) {
    case "win32":
      return `
        <h2>MPV Not Found (Windows)</h2>
        <p>This app needs MPV media player installed and available in your PATH.</p>
        <ul><li><a href="https://github.com/zhongfly/mpv-winbuild/releases/download/2025-07-28-a6f3236/mpv-x86_64-20250728-git-a6f3236.7z" target="_blank" style="color:#8f8">Download mpv-winbuild</a></li></ul>
        <p>After installing, restart this app.</p>`;
    case "darwin":
      return `<h2>MPV Not Found (macOS)</h2><p>Install with <code>brew install mpv</code></p>`;
    case "linux":
      return `<h2>MPV Not Found (Linux)</h2><p>Install with your package manager: <code>sudo apt install mpv</code></p>`;
    default:
      return `<h2>MPV Not Found</h2><p>Install MPV manually from https://mpv.io/</p>`;
  }
}

function showError(htmlMessage) {
  const message = getMPVErrorMessage(os.platform());
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`
    <body style="font-family:sans-serif;background:#111;color:#fff;padding:20px;">
      ${message}
      <p style="color:red;">${htmlMessage}</p>
    </body>`));
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const curl = spawn("curl", ["-L", "-A", "ElectronApp/1.0", "-o", dest, url]);
    curl.on("error", (err) => reject(new Error(`curl not found or failed: ${err.message}`)));
    curl.on("close", (code) => {
      if (code === 0 && fs.existsSync(dest)) {
        setTimeout(() => {
          const size = fs.statSync(dest).size;
          if (size < 1_000_000) {
            const html = fs.readFileSync(dest, "utf8");
            if (html.includes("<html")) return reject(new Error("Downloaded HTML instead of .7z"));
            return reject(new Error("Downloaded file is too small."));
          }
          resolve();
        }, 500);
      } else {
        reject(new Error(`curl exited with code ${code}`));
      }
    });
  });
}

function extractWith7z(archive, dest) {
  return new Promise(async (resolve, reject) => {
    const local7zrPath = path.join(app.getPath("userData"), "7zr.exe");
    const logPath = path.join(app.getPath("userData"), "7z-extract-log.txt");

    function spawn7z(sevenZipPath) {
      if (!fs.existsSync(archive)) return reject(new Error(`Archive not found: ${archive}`));
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });

      const args = ["x", archive, `-o${dest}`, "-y"];
      const out = fs.openSync(logPath, 'w');
      const proc = spawn(sevenZipPath, args, {
        windowsHide: true,
        stdio: ['ignore', out, out],
      });

      proc.on("error", (err) => reject(new Error(`Failed to launch 7z: ${err.message}`)));
      proc.on("close", (code) => {
        fs.closeSync(out);
        if (code === 0) resolve();
        else {
          const output = fs.readFileSync(logPath, "utf8");
          reject(new Error(`7z exited with code ${code}:

${output}`));
        }
      });
    }

    if (fs.existsSync(local7zrPath)) return spawn7z(local7zrPath);
    try {
      await downloadFile("https://www.7-zip.org/a/7zr.exe", local7zrPath);
      spawn7z(local7zrPath);
    } catch (err) {
      reject(new Error("Failed to download 7zr.exe: " + err.message));
    }
  });
}

async function attemptAutoInstallMPV() {
  win = new BrowserWindow({
    width: 600,
    height: 400,
    title: "Installing MPV...",
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`
    <body style="font-family:sans-serif;background:#111;color:#fff;padding:20px;">
      <h2>MPV Not Found</h2>
      <p>Attempting to download and install MPV for Windows...</p>
    </body>`));

  const archivePath = path.join(app.getPath("temp"), "mpv.7z");
  const archiveCopy = archivePath + ".copy.7z";
  const extractDir = path.join(app.getPath("userData"), "mpv");
  const MPV_URL = "https://github.com/zhongfly/mpv-winbuild/releases/download/2025-07-28-a6f3236/mpv-x86_64-20250728-git-a6f3236.7z";

  try {
    await downloadFile(MPV_URL, archivePath);
    fs.copyFileSync(archivePath, archiveCopy);
    await extractWith7z(archiveCopy, extractDir);
    process.env.PATH = `${extractDir};${process.env.PATH}`;
    await checkMPVInstalled();
    win.close();
    createWindow();
  } catch (e) {
    const message = getMPVErrorMessage("win32");
    const logPath = path.join(app.getPath("userData"), "7z-extract-log.txt");
    let errorDetails = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").slice(0, 800) : "";
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`
      <body style="font-family:sans-serif;background:#111;color:#fff;padding:20px;">
        ${message}
        <p style="color:red;">Automatic install failed: ${e.message}</p>
        <pre style="max-height: 300px; overflow-y: auto; background:#222; color:#ccc; padding:10px;">${errorDetails}</pre>
      </body>`));
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  win.loadFile("index.html");
}

app.whenReady().then(async () => {
  try {
    await checkMPVInstalled();
    createWindow();
  } catch {
    if (os.platform() === "win32") await attemptAutoInstallMPV();
    else showError("MPV not found");
  }
});



function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const curl = spawn("curl", ["-L", "-A", "ElectronApp/1.0", "-o", dest, url]);

    curl.on("error", (err) => reject(new Error(`curl not found or failed: ${err.message}`)));

    curl.on("close", (code) => {
      if (code === 0 && fs.existsSync(dest)) {
        setTimeout(() => {
          const size = fs.statSync(dest).size;
          if (size < 1_000_000) {
            const html = fs.readFileSync(dest, "utf8");
            if (html.includes("<html")) return reject(new Error("Downloaded HTML instead of .7z"));
            return reject(new Error("Downloaded file is too small."));
          }
          resolve();
        }, 100); // wait for Windows to unlock file
      } else {
        reject(new Error(`curl exited with code ${code}`));
      }
    });
  });
}


function extractWith7z(archive, dest) {
  return new Promise(async (resolve, reject) => {
    const isWin = os.platform() === "win32";
    const local7zrPath = path.join(app.getPath("userData"), "7zr.exe");
    const logPath = path.join(app.getPath("userData"), "7z-extract-log.txt");

    function spawn7z(sevenZipPath) {
      if (!fs.existsSync(archive)) {
        return reject(new Error(`Archive not found: ${archive}`));
      }

      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }

      const args = ["x", archive, `-o${dest}`, "-y"];
      const out = fs.openSync(logPath, 'w');

      const proc = spawn(sevenZipPath, args, {
        windowsHide: true,
        stdio: ['ignore', out, out], // redirect stdout/stderr to file
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to launch 7z: ${err.message}`));
      });

      proc.on("close", (code) => {
        fs.closeSync(out);
        if (code === 0) {
          resolve();
        } else {
          const output = fs.readFileSync(logPath, "utf8");
          reject(new Error(`7z exited with code ${code}:\n\n${output}`));
        }
      });
    }

    if (fs.existsSync(local7zrPath)) {
      return spawn7z(local7zrPath);
    }

    try {
      await downloadFile("https://www.7-zip.org/a/7zr.exe", local7zrPath);
      spawn7z(local7zrPath);
    } catch (err) {
      reject(new Error("Failed to download 7zr.exe: " + err.message));
    }
  });
}

async function attemptAutoInstallMPV() {
  win = new BrowserWindow({
    width: 600,
    height: 400,
    title: "Installing MPV...",
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  });
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`
    <body style="font-family:sans-serif;background:#111;color:#fff;padding:20px;">
      <h2>MPV Not Found</h2>
      <p>Attempting to download and install MPV for Windows...</p>
    </body>
  `));

  const MPV_URL = "https://github.com/zhongfly/mpv-winbuild/releases/download/2025-07-28-a6f3236/mpv-x86_64-20250728-git-a6f3236.7z";
  const archivePath = path.join(app.getPath("temp"), "mpv.7z");
  const extractDir = path.join(app.getPath("userData"), "mpv");

  try {
    await downloadFile(MPV_URL, archivePath);
    const archiveCopy = archivePath + ".copy.7z";
    fs.copyFileSync(archivePath, archiveCopy);
    await extractWith7z(archiveCopy, extractDir);
    process.env.PATH = `${extractDir};${process.env.PATH}`;
    await checkMPVInstalled();
    win.close();
    createWindow();
  } catch (e) {
    const logPath = path.join(app.getPath("userData"), "7z-extract-log.txt");
    let errorDetails = "";

    if (fs.existsSync(logPath)) {
      errorDetails = fs.readFileSync(logPath, "utf8").slice(0, 800); // max 800 chars
    }

    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`
  <body style="font-family:sans-serif;background:#111;color:#fff;padding:20px;">
    ${message}
    <p style="color:red;">Automatic install failed: ${e.message}</p>
    <pre style="max-height: 300px; overflow-y: auto; background:#222; color:#ccc; padding:10px;">${errorDetails}</pre>
  </body>
`));
  }
}

app.whenReady().then(async () => {
  try {
    await checkMPVInstalled();
    createWindow();
  } catch (err) {
    console.error("❌", err.message);
    const platform = os.platform();
    if (platform === "win32") {
      await attemptAutoInstallMPV();
    } else {
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

      errorWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`
        <body style="font-family:sans-serif;background:#111;color:#fff;padding:20px;">
          ${message}
        </body>
      `));

      errorWin.on("closed", () => {
        app.quit();
      });
    }
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
