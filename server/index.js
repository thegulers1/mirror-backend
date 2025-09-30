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
    const ext = (req.query.ext || 'webm').toString();
    const key = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    const expires = 60 * 5;

    const putUrl = await new Promise((resolve, reject) => {
      minioClient.presignedUrl('PUT', BUCKET, key, expires, (err, url) =>
        err ? reject(err) : resolve(url)
      );
    });

    res.json({ key, putUrl });
  } catch (e) {
    console.error('presign put failed:', e);
    console.log('presign put failed:', e);
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
    console.log('presign get failed:', e);
    res.status(500).json({ error: 'presign get failed' });
  }
});

// --------- Proxy download (Dosyalara indir) ----------
app.get('/download', async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).send('key gerekli');
  try {
    const srcUrl = await new Promise((resolve, reject) => {
      minioClient.presignedUrl('GET', BUCKET, key, 3600, (err, url) =>
        err ? reject(err) : resolve(url)
      );
    });
    const r = await fetch(srcUrl);
    if (!r.ok) return res.status(502).send('minio fetch failed');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="mirror-video.mp4"');
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    console.error('proxy download error', e);
    res.status(500).send('download failed');
  }
});

// --------- DL (landing) sayfası: iOS/Android/PC uyumlu ----------
app.get('/dl', async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).send('key parametresi gerekli');

  try {
    const viewUrl = `https://minio-api.metasoftco.com/mirrorvideo/${encodeURIComponent(key)}`

    const proxyUrl = `${process.env.PUBLIC_BASE_URL || 'https://mirror-draw.metasoftco.com'}/download?key=${encodeURIComponent(key)}`;

    // HTML template'ine runtime değerleri enjekte et
    // Not: Basit string replace ile placeholder'lar doldurulur
    const tplPath = path.join(__dirname, 'views', 'dl.html');
    const tpl = fs.readFileSync(tplPath, 'utf8');
    const html = tpl
      .replaceAll('{{VIEW_URL}}', viewUrl)
      .replaceAll('{{PROXY_URL}}', proxyUrl);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('DL route error', e);
    res.status(500).send('Video linki alınamadı');
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

      // ffmpeg ile mirrored + frame overlay mp4 üret
      const outPath = srcPath.replace(/\.webm$/i, '') + '-mirrored.mp4';
      await new Promise((resolve, reject) => {
        const framePath = path.resolve(__dirname, '..', 'cerceve3.png');
        // Çerçeve dosyası var mı kontrol et
        if (!fs.existsSync(framePath)) {
          console.warn('cerceve3.png bulunamadı:', framePath);
        }else {
          console.log('cerceve3.png bulundu:', framePath);
        }
        const args = [
          '-y',
          '-noautorotate',              // <-- ekle
          '-i', srcPath,                // 0: video
          '-loop', '1', '-i', framePath,// 1: PNG
          '-filter_complex',
          '[0:v]hflip,format=rgba[base];' +
          '[1:v][base]scale2ref=flags=lanczos[fg][base2];' +
          '[fg]format=rgba[fg2];' +
          '[base2][fg2]overlay=0:0[out]',
          '-map', '[out]', '-map', '0:a?',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
          '-c:a', 'aac', '-b:a', '128k',
          '-pix_fmt', 'yuv420p',
          '-movflags', 'faststart',
          '-shortest',
          outPath,
        ];
        
        // ffmpeg çağrısını ve argümanlarını logla
        console.log('ffmpeg run', { args });
        execFile('ffmpeg', args, (err, stdout, stderr) => {
          // ffmpeg çıktısını logla (hata durumunda teşhis kolaylığı için)
          if (err) {
            console.log('ffmpeg error', { message: err.message, code: err.code, signal: err.signal, stderr: String(stderr) });
            reject(err);
            return;
          }
          console.log('ffmpeg completed', { stdout: String(stdout).slice(0, 1000), stderr: String(stderr).slice(0, 1000) });
          resolve();
        });
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
      console.log('upload-done error', e);
      
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
