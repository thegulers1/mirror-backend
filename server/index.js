// server/index.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Minio = require('minio');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // /video ve /moderasyon burada servis edilecek

// --------- MinIO CONFIG (fallback'lerle) ----------
const MINIO_ENDPOINT =
  process.env.MINIO_ENDPOINT ||
  process.env.NEXT_PUBLIC_MINIO_ENDPOINT; // fallback

const MINIO_PORT = Number(process.env.MINIO_PORT || 443);
const MINIO_USE_SSL = String(process.env.MINIO_USE_SSL || 'true') === 'true';
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY;
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY;

const BUCKET =
  process.env.MINIO_BUCKET ||
  process.env.NEXT_PUBLIC_MINIO_BUCKET_NAME; // fallback

// Başlangıçta bir kez loglayalım (debug için)
console.log('MinIO config =>', {
  endPoint: MINIO_ENDPOINT,
  port: MINIO_PORT,
  useSSL: MINIO_USE_SSL,
  BUCKET,
  hasKeys: !!(MINIO_ACCESS_KEY && MINIO_SECRET_KEY),
});

// Zorunlu alan kontrolleri
if (!MINIO_ENDPOINT) {
  throw new Error('MINIO_ENDPOINT (veya NEXT_PUBLIC_MINIO_ENDPOINT) tanımlı değil.');
}
if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) {
  throw new Error('MINIO_ACCESS_KEY / MINIO_SECRET_KEY tanımlı değil.');
}
if (!BUCKET) {
  throw new Error('MINIO_BUCKET (veya NEXT_PUBLIC_MINIO_BUCKET_NAME) tanımlı değil.');
}

// MinIO client
const minioClient = new Minio.Client({
  endPoint: MINIO_ENDPOINT,        // sadece host adı, protokol YOK
  port: MINIO_PORT,                 // 443
  useSSL: MINIO_USE_SSL,            // true
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
});

// İstersen ilk açılışta bucket'ları listeleyip bağlantıyı test edebilirsin:
minioClient.listBuckets((err, buckets) => {
  if (err) {
    console.error('MinIO bağlantı hatası:', err?.message || err);
  } else {
    console.log('MinIO buckets:', buckets.map(b => b.name));
  }
});

// --------- Socket.IO ----------
const allowedOrigin =
  process.env.ALLOWED_ORIGIN ||            // tek domain vermek istersen
  process.env.NEXT_PUBLIC_SITE_URL ||      // ör: https://faceswapv2.metasoftco.com
  '*';

const server = http.createServer(app);
const io = new Server(server, {
  path: process.env.SOCKET_PATH || '/socket.io',
  cors: { origin: allowedOrigin, methods: ['GET', 'POST'] }
});

// Tek kabin/tek recorder varsayımı:
let recorderSocketId = null;
let moderatorSocketId = null;

// Basit health
app.get('/health', (_, res) => res.send('ok'));

// --------- API: Pre-signed PUT (Recorder çağırır) ----------
app.post('/api/presign/put', async (req, res) => {
  try {
    const eventId = (req.query.eventId || 'default-event').toString();
    // dosya adı: eventId/timestamp-rand.webm (veya .mp4)
    const ext = (req.query.ext || 'webm').toString(); // istersen ?ext=mp4 ile kontrol et
    const key = `${eventId}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;

    const expires = 60 * 5; // 5 dk
    const putUrl = await new Promise((resolve, reject) => {
      minioClient.presignedUrl('PUT', BUCKET, key, expires, (err, url) => {
        if (err) return reject(err);
        resolve(url);
      });
    });

    res.json({ key, putUrl });
  } catch (e) {
    console.error('presign put failed:', e);
    res.status(500).json({ error: 'presign put failed' });
  }
});

// --------- API: Pre-signed GET (Moderasyon QR için) ----------
app.get('/api/presign/get', async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).json({ error: 'key required' });

    const expires = 60 * 60 * 2; // 2 saat
    const getUrl = await new Promise((resolve, reject) => {
      minioClient.presignedUrl('GET', BUCKET, key, expires, (err, url) => {
        if (err) return reject(err);
        resolve(url);
      });
    });

    res.json({ getUrl });
  } catch (e) {
    console.error('presign get failed:', e);
    res.status(500).json({ error: 'presign get failed' });
  }
});

// --------- Socket olayları ----------
io.on('connection', (socket) => {
  // Kimlik: recorder mı moderasyon mu?
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

  // Moderasyon "start" basınca:
  socket.on('moderator-start', (payload) => {
    // payload: { eventId?: string, durationMs?: number, ext?: 'webm'|'mp4' }
    if (recorderSocketId) {
      io.to(recorderSocketId).emit('record-start', payload || {});
    }
  });

  // Recorder “upload-done” deyince:
  socket.on('upload-done', async ({ key }) => {
    try {
      const expires = 60 * 60 * 2;
      const getUrl = await new Promise((resolve, reject) => {
        minioClient.presignedUrl('GET', BUCKET, key, expires, (err, url) => {
          if (err) return reject(err);
          resolve(url);
        });
      });
      if (moderatorSocketId) {
        io.to(moderatorSocketId).emit('video-ready', { key, getUrl });
      }
    } catch (e) {
      console.error('upload-done error:', e);
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

// --------- Basit 404 ve hata yakalayıcı ----------
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// --------- Server başlat ----------
const port = process.env.PORT || 8080;
server.listen(port, () => console.log('Server listening on', port));
