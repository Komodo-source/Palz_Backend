const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { getUserId } = require('../middleware/auth');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

async function uploadRoutes(app) {
  // Upload profile image
  app.post('/image', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const data = await request.file();

      if (!data) {
        return reply.status(400).send({ error: 'No file uploaded' });
      }

      // Validate file type
      const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
      if (!allowedMimes.includes(data.mimetype)) {
        return reply.status(400).send({ error: 'Invalid image type. Allowed: JPEG, PNG, WebP, GIF' });
      }

      const ext = path.extname(data.filename) || '.jpg';
      const filename = `img_${userId}_${Date.now()}${ext}`;
      const filepath = path.join(UPLOAD_DIR, filename);

      await pipeline(data.file, fs.createWriteStream(filepath));

      const url = `/uploads/${filename}`;
      return reply.send({ url, filename });
    } catch (err) {
      console.error('Image upload error:', err);
      return reply.status(500).send({ error: 'Upload failed', details: process.env.NODE_ENV !== 'production' || process.env.EXPOSE_ERROR_DETAILS === 'true' ? err.message : undefined });
    }
  });

  // Upload audio fun fact (voice clip — premium feature)
  app.post('/audio', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const data = await request.file();

      if (!data) {
        return reply.status(400).send({ error: 'No file uploaded' });
      }

      // Validate file type
      const allowedMimes = ['audio/m4a', 'audio/mp4', 'audio/mpeg', 'audio/aac',
                            'audio/wav', 'audio/x-m4a', 'audio/x-wav',
                            'audio/ogg', 'audio/webm', 'audio/3gpp'];
      if (!allowedMimes.includes(data.mimetype)) {
        return reply.status(400).send({ error: 'Invalid audio type. Allowed: M4A, MP3, AAC, WAV, OGG, WebM' });
      }

      const ext = path.extname(data.filename) || '.m4a';
      const filename = `audio_${userId}_${Date.now()}${ext}`;
      const filepath = path.join(UPLOAD_DIR, filename);

      await pipeline(data.file, fs.createWriteStream(filepath));

      const url = `/uploads/${filename}`;
      return reply.send({ url, filename });
    } catch (err) {
      console.error('Audio upload error:', err);
      return reply.status(500).send({ error: 'Upload failed', details: process.env.NODE_ENV !== 'production' || process.env.EXPOSE_ERROR_DETAILS === 'true' ? err.message : undefined });
    }
  });
}

module.exports = { uploadRoutes };
