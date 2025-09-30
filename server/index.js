// server/index.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Minio = require('minio');
const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --------- MinIO CONFIG ----------
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || process.env.NEXT_PUBLIC_MINIO_ENDPOINT;
const MINIO_PORT = Number(process.env.MINIO_PORT || 443);
const MINIO_USE_SSL = String(process.env.MINIO_USE_SSL || 'true') === 'true';
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY;
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY;
const BUCKET = process.env.MINIO_BUCKET || process.env.NEXT_PUBLIC_MINIO_BUCKET_NAME;

console.log('MinIO config =>', {
  endPoint: MINIO_ENDPOINT,
  port: MINIO_PORT,
  useSSL: MINIO_USE_SSL,
  BUCKET,
  hasKeys: !!(MINIO_ACCESS_KEY && MINIO_SECRET_KEY),
});

const minioClient = new Minio.Client({
  endPoint: MINIO_ENDPOINT,
  port: MINIO_PORT,
  useSSL: MINIO_USE_SSL,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
});

// Health
app.get('/health', (_, res) => res.send('ok'));

// --------- Pre-signed PUT ----------
app.post('/api/presign/put', async (req, res) => {
  try {
    const eventId = (req.query.eventId || 'default-event').toString();
    const ext = (req.query.ext || 'webm').toString();
    const key = `${eventId}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    const expires = 60 * 5;

    const putUrl = await new Promise((resolve, reject) => {
      minioClient.presignedUrl('PUT', BUCKET, key, expires, (err, url) =>
        err ? reject(err) : resolve(url)
      );
    });

    res.json({ key, putUrl });
  } catch (e) {
    console.error('presign put failed:', e);
    res.status(500).json({ error: 'presign put failed' });
  }
});

// --------- Pre-signed GET ----------
app.get('/api/presign/get', async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).json({ error: 'key required' });
    const expires = 60 * 60 * 2;

    const getUrl = await new Promise((resolve, reject) => {
      minioClient.presignedUrl('GET', BUCKET, key, expires, (err, url) =>
        err ? reject(err) : resolve(url)
      );
    });

    res.json({ getUrl });
  } catch (e) {
    console.error('presign get failed:', e);
    res.status(500).json({ error: 'presign get failed' });
  }
});

// --------- Socket.IO ----------
const allowedOrigin =
  process.env.ALLOWED_ORIGIN ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  '*';

const server = http.createServer(app);
const io = new Server(server, {
  path: process.env.SOCKET_PATH || '/socket.io',
  cors: { origin: allowedOrigin, methods: ['GET', 'POST'] },
});

let recorderSocketId = null;
let moderatorSocketId = null;

// helpers
function presignGet(key, expiresSec = 7200) {
  return new Promise((resolve, reject) => {
    minioClient.presignedUrl('GET', BUCKET, key, expiresSec, (err, url) =>
      err ? reject(err) : resolve(url)
    );
  });
}
function presignPut(key, expiresSec = 300) {
  return new Promise((resolve, reject) => {
    minioClient.presignedUrl('PUT', BUCKET, key, expiresSec, (err, url) =>
      err ? reject(err) : resolve(url)
    );
  });
}
async function downloadToTemp(url, ext = '') {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-')) + (ext || '');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dst, buffer);
  return dst;
}
async function uploadFromFile(putUrl, filePath, contentType) {
  await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
    body: fs.readFileSync(filePath),
  });
}

// socket connection
io.on('connection', (socket) => {
  socket.on('register', (role) => {
    if (role === 'recorder') {
      recorderSocketId = socket.id;
      console.log('Recorder connected:', socket.id);
      if (moderatorSocketId) io.to(moderatorSocketId).emit('recorder-status', { ready: true });
    } else if (role === 'moderator') {
      moderatorSocketId = socket.id;
      console.log('Moderator connected:', socket.id);
      io.to(moderatorSocketId).emit('recorder-status', { ready: !!recorderSocketId });
    }
  });

  socket.on('moderator-start', (payload) => {
    if (recorderSocketId) {
      io.to(recorderSocketId).emit('record-start', payload || {});
    }
  });

  // upload-done: convert webm -> mirrored mp4
  socket.on('upload-done', async ({ key }) => {
    try {
      // indir webm
      const srcGet = await presignGet(key, 600);
      const srcPath = await downloadToTemp(srcGet, '.webm');

      // ffmpeg ile mirrored mp4 üret
      const outPath = srcPath.replace(/\.webm$/i, '') + '-mirrored.mp4';
      await new Promise((resolve, reject) => {
        const args = [
          '-y', '-i', srcPath,
          '-vf', 'hflip',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-movflags', 'faststart',
          outPath,
        ];
        execFile('ffmpeg', args, (err) => (err ? reject(err) : resolve()));
      });

      // mp4'ü MinIO'ya yükle
      const mp4Key = key.replace(/\.webm$/i, '') + '-mirrored.mp4';
      const putUrl = await presignPut(mp4Key, 600);
      await uploadFromFile(putUrl, outPath, 'video/mp4');

      // moderasyona mp4 landing url gönder
      const base = process.env.PUBLIC_BASE_URL || 'https://mirror-draw.metasoftco.com';
      const landingUrl = `${base}/dl?key=${encodeURIComponent(mp4Key)}`;
      if (moderatorSocketId) {
        io.to(moderatorSocketId).emit('video-ready', { key: mp4Key, landingUrl });
      }

      // cleanup
      try { fs.unlinkSync(srcPath); } catch {}
      try { fs.unlinkSync(outPath); } catch {}
    } catch (e) {
      console.error('upload-done error', e);
      // fallback: orijinal webm gönder
      const base = process.env.PUBLIC_BASE_URL || 'https://mirror-draw.metasoftco.com';
      const landingUrl = `${base}/dl?key=${encodeURIComponent(key)}`;
      if (moderatorSocketId) {
        io.to(moderatorSocketId).emit('video-ready', { key, landingUrl });
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.id === recorderSocketId) {
      recorderSocketId = null;
      if (moderatorSocketId) io.to(moderatorSocketId).emit('recorder-status', { ready: false });
    } else if (socket.id === moderatorSocketId) {
      moderatorSocketId = null;
    }
  });
});

// --------- DL (landing) sayfası ----------
app.get('/dl', async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).send('key parametresi gerekli');

  try {
    // iOS tespiti
    const ua = (req.headers['user-agent'] || '');
    const isIOS = /iPhone|iPad|iPod/i.test(ua);

    // 1) iOS için: attachment YOK (oynatıcıda açılır → uzun bas = 'Videoyu Kaydet')
    const viewUrl = await new Promise((resolve, reject) => {
      minioClient.presignedUrl(
        'GET',
        BUCKET,
        key,
        60 * 60, // 1 saat
        {},      // header override yok
        (err, url) => err ? reject(err) : resolve(url)
      );
    });

    // 2) Diğer cihazlar için: attachment (indir)
    const downloadUrl = await new Promise((resolve, reject) => {
      minioClient.presignedUrl(
        'GET',
        BUCKET,
        key,
        60 * 60,
        { 'response-content-disposition': 'attachment; filename="mirror-video.mp4"' },
        (err, url) => err ? reject(err) : resolve(url)
      );
    });

    // iOS kullanıcılarını TERCIHEN viewUrl'e yönlendirebilirsin, ama sayfada iki butonu da gösterelim:
    res.send(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>Videonu İndir</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          :root { color-scheme: dark; }
          body { background:#0b0f15; color:#fff; font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; text-align:center; padding:24px; }
          .btn { display:inline-block; margin:8px 6px; padding:14px 18px; font-size:18px; border-radius:12px; border:0; background:#1f6feb; color:#fff; text-decoration:none; }
          .btn.secondary { background:#263042; }
          video { max-width:100%; border-radius:12px; margin:18px 0; }
          .muted { opacity:.85; font-size:14px; line-height:1.4; max-width:720px; margin:0 auto; }
        </style>
      </head>
      <body>
        <h2>Videon Hazır 🎉</h2>

        <video src="${viewUrl}" controls playsinline></video>

        <div style="margin:10px 0 2px;">
          <a class="btn" href="${viewUrl}" target="_blank" rel="noopener">📺 iPhone'da Aç</a>
          <a class="btn secondary" href="${downloadUrl}" target="_blank" rel="noopener">📥 Bilgisayarda/Android’de İndir</a>
        </div>

        <div style="margin-top:8px;">
          <button class="btn secondary" id="shareFile" style="display:none;">📤 Paylaş / Kaydet (iOS)</button>
        </div>

        <p class="muted" style="margin-top:12px;">
          iPhone: Üstteki “iPhone'da Aç” ile videoyu açın, <b>videonun üzerine uzun basın</b> → <b>“Videoyu Kaydet”</b>.
          <br/>Bilgisayar/Android: “İndir” ile direkt indirin.
        </p>

        <script>
          (function () {
            const isIOS = ${JSON.stringify(isIOS)};
            const viewUrl = ${JSON.stringify(viewUrl)};
            const downloadUrl = ${JSON.stringify(downloadUrl)};
            // Web Share Level 2 (dosya paylaşımı) destekleniyorsa iOS’ta gerçek dosyayı paylaşarak "Videoyu Kaydet" seçeneğini tetikleyebiliriz
            const btn = document.getElementById('shareFile');

            async function shareActualFile() {
              try {
                const r = await fetch(viewUrl, { mode: 'cors' });
                if (!r.ok) throw new Error('fetch failed: ' + r.status);
                const blob = await r.blob();
                const file = new File([blob], 'mirror-video.mp4', { type: 'video/mp4' });
                if (navigator.canShare && navigator.canShare({ files: [file] })) {
                  await navigator.share({ files: [file], title: 'Mirror Video', text: 'Videomu kaydet' });
                } else {
                  // cihaz dosya paylaşımını desteklemiyorsa, normal aç
                  location.href = viewUrl;
                }
              } catch (e) {
                console.log('share failed', e);
                location.href = viewUrl; // fallback
              }
            }

            if (isIOS && navigator.share) {
              // iOS + share destekli → butonu göster
              btn.style.display = 'inline-block';
              btn.addEventListener('click', shareActualFile);
            }
          })();
        </script>
      </body>
      </html>
    `);
  } catch (e) {
    console.error('DL route error', e);
    res.status(500).send('Video linki alınamadı');
  }
});


// --------- Error handlers ----------
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// --------- Start server ----------
const port = process.env.PORT || 8080;
server.listen(port, '0.0.0.0', () => console.log('Server listening on', port));
