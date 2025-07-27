const WebTorrent = require("webtorrent");
const express = require("express");
const { spawn } = require("child_process");

async function spawnTorrentServer(magnetURI, port = 8888) {
  return new Promise((resolve, reject) => {
    const client = new WebTorrent();
    const app = express();
    let torrent = null;

    app.get("/video", (req, res) => {
      if (!torrent) return res.status(503).send("Torrent not ready");

      const file = torrent.files.find(f =>
          f.name.match(/\.(mp4|mkv|webm)$/i)
      ) || torrent.files[0];

      if (!file) return res.status(404).send("Video not found");

      file.select();

      const isMKV = file.name.toLowerCase().endsWith(".mkv");

      // if (isMKV) {
      //   console.log(`Transcoding ${file.name} on the fly...`);
      //
      //   res.writeHead(200, {
      //     "Content-Type": "video/mp4",
      //     "Transfer-Encoding": "chunked",
      //   });
      //
      //   const stream = file.createReadStream();
      //   const ffmpeg = spawn("ffmpeg", [
      //     "-i", "pipe:0",
      //     "-f", "mp4",
      //     "-vcodec", "libx264",
      //     "-acodec", "aac",
      //     "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      //     "-preset", "ultrafast",
      //     "pipe:1",
      //   ]);
      //
      //   stream.pipe(ffmpeg.stdin);
      //   ffmpeg.stdout.pipe(res);
      //
      //   ffmpeg.stderr.on("data", (data) => {
      //     console.error(`FFmpeg error: ${data}`);
      //   });
      //
      //   res.on("close", () => {
      //     console.log("Client disconnected. Killing FFmpeg.");
      //     ffmpeg.kill("SIGINT");
      //     stream.destroy();
      //   });
      //
      // } else {
        // Direct stream for mp4 or webm
        const range = req.headers.range;
        const total = file.length;

        if (!range) {
          res.writeHead(200, {
            "Content-Length": total,
            "Content-Type": "video/mp4",
          });

          const stream = file.createReadStream();

          stream.on("error", (err) => {
            if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
              console.error("❌ Stream error:", err);
            }
          });

          res.on("close", () => {
            console.log("⚠️ Client closed connection early");
            stream.destroy();
          });

          return stream.pipe(res);
        }

        const [start, endRaw] = range.replace(/bytes=/, "").split("-");
        const startByte = parseInt(start, 10);
        const endByte = endRaw ? parseInt(endRaw, 10) : total - 1;

        res.writeHead(206, {
          "Content-Range": `bytes ${startByte}-${endByte}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": endByte - startByte + 1,
          "Content-Type": "video/mp4",
        });

        const stream = file.createReadStream({ start: startByte, end: endByte });

        stream.on("error", (err) => {
          if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
            console.error("❌ Stream error:", err);
          }
        });

        res.on("close", () => {
          console.log("⚠️ Client closed connection early");
          stream.destroy();
        });

        stream.pipe(res);
      // }
    });

    app.listen(port, () => {
      console.log(`📺 Torrent server on http://localhost:${port}/video`);
    });

    client.add(magnetURI, (t) => {
      torrent = t;
      const file = t.files.find(f =>
          f.name.match(/\.(mp4|mkv|webm)$/i)
      ) || t.files[0];
      resolve({ fileName: file.name, torrent, port });
    });
  });
}

module.exports = { spawnTorrentServer };
