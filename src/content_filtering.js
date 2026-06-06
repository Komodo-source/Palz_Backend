const BAN_WORD_LIST = [
  // Contenu haineux
  'nigger', 'nigga', 'faggot', 'tranny', 'retard', 'spic', 'chink', 'kike',
  // Contenu sexuel explicite
  'pornhub', 'onlyfans', 'nude', 'nudes',
  // Harcèlement / menaces
  'je vais te tuer', 'va mourir', 'suicide toi', 'crève',
  // Spam
  'bitcoin gratuit', 'argent facile', 'cliquez ici pour gagner',
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

/**
 * Vérifie un texte contre la liste de mots interdits.
 * Retourne le mot trouvé ou null si le contenu est propre.
 */
function checkTextContent(text) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase();
  return BAN_WORD_LIST.find((word) => lower.includes(word)) || null;
}

/**
 * Vérification de sécurité côté serveur pour les images uploadées.
 *
 * NOTE production : intégrer une API NSFW dédiée :
 *   - Google Cloud Vision SafeSearch API
 *   - AWS Rekognition DetectModerationLabels
 *   - Azure Content Moderator
 *
 * Exemple Google Vision :
 *   const [result] = await visionClient.safeSearchDetection({ image: { content: buffer } });
 *   const { adult, violence } = result.safeSearchAnnotation;
 *   const blocked = ['LIKELY', 'VERY_LIKELY'];
 *   if (blocked.includes(adult) || blocked.includes(violence))
 *     return { safe: false, reason: 'NSFW content detected' };
 */
async function checkImageSafety(buffer, mimeType) {
  if (!validateMagicBytes(buffer, mimeType)) {
    return { safe: false, reason: 'Magic bytes mismatch — possible file type spoofing' };
  }
  // TODO: remplacer par un appel à l'API de modération en production
  return { safe: true };
}

module.exports = { checkImageSafety, checkTextContent, validateMagicBytes, BAN_WORD_LIST };
