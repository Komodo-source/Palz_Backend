const BAN_WORD_LIST = [
  'nigger', 'nigga', 'faggot', 'tranny', 'retard', 'spic', 'chink', 'kike',
  'pornhub', 'onlyfans', 'nude', 'nudes','of','mym','0f',
  'je vais te tuer', 'va mourir', 'suicide toi', 'crève','suicide', 'viol',
  'bitcoin', 'argent facile', 'cliquez ici pour gagner',
];

const MAGIC_BYTES = {
  'image/jpeg': Buffer.from([0xFF, 0xD8, 0xFF]),
  'image/png':  Buffer.from([0x89, 0x50, 0x4E, 0x47]),
  'image/webp': Buffer.from([0x52, 0x49, 0x46, 0x46]),
  'image/gif':  Buffer.from([0x47, 0x49, 0x46, 0x38]),
};

/**
 * Validate that a buffer's magic bytes match the declared MIME type.
 * Prevents MIME-type spoofing (ex: uploader un HTML déguisé en JPEG).
 */
function validateMagicBytes(buffer, mimeType) {
  const sig = MAGIC_BYTES[mimeType];
  if (!sig) return true; // Pas de signature connue — on accepte (ex: HEIC)
  return buffer.slice(0, sig.length).equals(sig);
}


// Cached once at first use — model is ~80 MB, loading per-request would be too slow
let _nsfwModel = null;
async function getNsfwModel() {
  if (!_nsfwModel) {
    const nsfw = require('nsfwjs');
    _nsfwModel = await nsfw.load();
  }
  return _nsfwModel;
}

async function checkImageNSFW(buffer) {
  const tf = require('@tensorflow/tfjs');
  const sharp = require('sharp');

  const { data, info } = await sharp(buffer)
    .resize(224, 224)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const model = await getNsfwModel();
  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);
  const predictions = await model.classify(tensor);
  tensor.dispose();

  const unsafe = predictions.find(
    (p) => ['Porn', 'Hentai'].includes(p.className) && p.probability > 0.7
  );
  return { safe: !unsafe, prediction: unsafe || null };
}

/**
 * Vérifie un texte contre la liste de mots interdits.
 * Retourne le mot trouvé ou null si le contenu est propre.
 */
function checkTextContent(text) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase();
  return BAN_WORD_LIST.find((word) => lower.includes(word)) || null;
}


async function checkImageSafety(buffer, mimeType) {
  if (!validateMagicBytes(buffer, mimeType)) {
    return { safe: false, reason: 'Magic bytes mismatch — possible file type spoofing' };
  }

  return { safe: true };
}

module.exports = { checkImageSafety, checkTextContent, validateMagicBytes, BAN_WORD_LIST, checkImageNSFW };
