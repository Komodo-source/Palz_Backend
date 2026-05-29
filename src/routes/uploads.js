const path = require('path');
const { getUserId } = require('../middleware/auth');
const { supabase } = require('../supabase');
const { query } = require('../db');
const { exposeErrorDetails } = require('../debug');

function sanitizeName(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .substring(0, 50) || 'user';
}

let sharp;
try {
  sharp = require('sharp');
} catch {
  // Sharp is optional — images upload without compression if not installed
  sharp = null;
}

/**
 * Compress an image buffer with Sharp if available.
 * Resizes to max 1200px wide, converts to JPEG at 85% quality.
 * Falls back to the original buffer if Sharp isn't installed.
 */
async function compressImage(buffer) {
  if (!sharp) return { buffer, contentType: 'image/jpeg' };
  try {
    const compressed = await sharp(buffer)
      .rotate()
      .resize({ width: 1200, withoutEnlargement: true })
      .jpeg({ quality: 90, progressive: true })
      .toBuffer();
    return { buffer: compressed, contentType: 'image/jpeg' };
  } catch {
    return { buffer, contentType: 'image/jpeg' };
  }
}

async function uploadRoutes(app) {
  // Upload profile/chat image → Supabase "user_photos" bucket
  app.post('/image', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const data = await request.file();

      if (!data) {
        return reply.status(400).send({ error: 'No file uploaded' });
      }

      const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
      if (!allowedMimes.includes(data.mimetype)) {
        return reply.status(400).send({ error: 'Invalid image type. Allowed: JPEG, PNG, WebP, GIF, HEIC' });
      }

      // Read file into buffer
      const chunks = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const rawBuffer = Buffer.concat(chunks);

      // Compress with Sharp (auto-rotates EXIF, resizes, converts to JPEG)
      const { buffer, contentType } = await compressImage(rawBuffer);

      const filename = `img_${userId}_${Date.now()}.jpg`;

      const { error: uploadError } = await supabase.storage
        .from('user_photos')
        .upload(filename, buffer, { contentType, upsert: false });

      if (uploadError) {
        console.error('Supabase image upload error:', uploadError);
        return reply.status(500).send({ error: 'Upload failed', details: uploadError.message });
      }

      const { data: publicUrlData } = supabase.storage
        .from('user_photos')
        .getPublicUrl(filename);

      return reply.send({ url: publicUrlData.publicUrl, filename });
    } catch (err) {
      console.error('Image upload error:', err);
      return reply.status(500).send({
        error: 'Upload failed',
        details: exposeErrorDetails(request) ? err.message : undefined,
      });
    }
  });

  // Upload audio fun fact → Supabase "audio_users" bucket
  app.post('/audio', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const data = await request.file();

      if (!data) {
        return reply.status(400).send({ error: 'No file uploaded' });
      }

      const allowedMimes = [
        'audio/m4a', 'audio/mp4', 'audio/mpeg', 'audio/aac',
        'audio/wav', 'audio/x-m4a', 'audio/x-wav',
        'audio/ogg', 'audio/webm', 'audio/3gpp',
      ];
      if (!allowedMimes.includes(data.mimetype)) {
        return reply.status(400).send({
          error: 'Invalid audio type. Allowed: M4A, MP3, AAC, WAV, OGG, WebM',
        });
      }

      const ext = path.extname(data.filename) || '.m4a';
      const filename = `audio_${userId}_${Date.now()}${ext}`;

      const chunks = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      let { error: uploadError } = await supabase.storage
        .from('audio_users')
        .upload(filename, buffer, {
          contentType: data.mimetype,
          upsert: false,
        });

      if (uploadError?.message?.toLowerCase().includes('bucket') || uploadError?.statusCode === '404') {
        await supabase.storage.createBucket('audio_users', { public: true });
        ({ error: uploadError } = await supabase.storage
          .from('audio_users')
          .upload(filename, buffer, { contentType: data.mimetype, upsert: false }));
      }

      if (uploadError) {
        console.error('Supabase audio upload error:', uploadError);
        return reply.status(500).send({ error: 'Upload failed', details: uploadError.message });
      }

      const { data: publicUrlData } = supabase.storage
        .from('audio_users')
        .getPublicUrl(filename);

      return reply.send({ url: publicUrlData.publicUrl, filename });
    } catch (err) {
      console.error('Audio upload error:', err);
      return reply.status(500).send({
        error: 'Upload failed',
        details: exposeErrorDetails(request) ? err.message : undefined,
      });
    }
  });
  // Upload video verification → Supabase "video_verifications" bucket
  app.post('/video-verification', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);

      // Fetch the user's full_name to embed in the filename
      const userResult = await query('SELECT full_name FROM users WHERE id = $1', [userId]);
      if (userResult.rows.length === 0) {
        return reply.status(404).send({ error: 'User not found' });
      }
      const fullName = userResult.rows[0].full_name || 'user';

      // Allow up to 200 MB for a verification video
      const data = await request.file({ limits: { fileSize: 200 * 1024 * 1024 } });

      if (!data) {
        return reply.status(400).send({ error: 'No file uploaded' });
      }

      const allowedMimes = [
        'video/mp4', 'video/quicktime', 'video/x-msvideo',
        'video/webm', 'video/3gpp', 'video/mpeg',
      ];
      if (!allowedMimes.includes(data.mimetype)) {
        return reply.status(400).send({
          error: 'Invalid video type. Allowed: MP4, MOV, AVI, WebM, 3GP, MPEG',
        });
      }

      const ext = path.extname(data.filename) || '.mp4';
      const safeName = sanitizeName(fullName);
      const filename = `verification_${safeName}_${userId}_${Date.now()}${ext}`;

      const chunks = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      const { error: uploadError } = await supabase.storage
        .from('video_verifications')
        .upload(filename, buffer, {
          contentType: data.mimetype,
          upsert: false,
        });

      if (uploadError) {
        console.error('Supabase video upload error:', uploadError);
        return reply.status(500).send({ error: 'Upload failed', details: uploadError.message });
      }

      const { data: publicUrlData } = supabase.storage
        .from('video_verifications')
        .getPublicUrl(filename);

      const videoUrl = publicUrlData.publicUrl;

      // Persist URL and set status to pending admin review
      await query(
        `UPDATE users
         SET video_verification_url = $1, video_verification_status = 'pending', updated_at = NOW()
         WHERE id = $2`,
        [videoUrl, userId]
      );

      return reply.send({ url: videoUrl, filename, status: 'pending' });
    } catch (err) {
      console.error('Video verification upload error:', err);
      return reply.status(500).send({
        error: 'Upload failed',
        details: exposeErrorDetails(request) ? err.message : undefined,
      });
    }
  });
}

module.exports = { uploadRoutes };
