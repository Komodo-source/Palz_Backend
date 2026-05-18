const path = require('path');
const { getUserId } = require('../middleware/auth');
const { supabase } = require('../supabase');
const { exposeErrorDetails } = require('../debug');

async function uploadRoutes(app) {
  // Upload profile image → Supabase "user_photos" bucket
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

      // Read file into buffer
      const chunks = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      // Upload to Supabase storage
      const { error: uploadError } = await supabase.storage
        .from('user_photos')
        .upload(filename, buffer, {
          contentType: data.mimetype,
          upsert: false,
        });

      if (uploadError) {
        console.error('Supabase image upload error:', uploadError);
        return reply.status(500).send({ error: 'Upload failed', details: uploadError.message });
      }

      // Get public URL
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

      // Validate file type
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

      // Read file into buffer
      const chunks = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      // Upload to Supabase storage
      const { error: uploadError } = await supabase.storage
        .from('audio_users')
        .upload(filename, buffer, {
          contentType: data.mimetype,
          upsert: false,
        });

      if (uploadError) {
        console.error('Supabase audio upload error:', uploadError);
        return reply.status(500).send({ error: 'Upload failed', details: uploadError.message });
      }

      // Get public URL
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
}

module.exports = { uploadRoutes };
