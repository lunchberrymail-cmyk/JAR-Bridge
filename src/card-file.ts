/** Local-only conversion into the native Lumiverse character-card importer. */
export const MAX_AVATAR_BYTES = 10 * 1024 * 1024;
const MAX_CARD_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_SIDE = 16_384;
const MAX_IMAGE_PIXELS = 40_000_000;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const encoder = new TextEncoder();

export class CardFileError extends Error {
  constructor(readonly code: 'invalid_card' | 'invalid_avatar' | 'avatar_too_large' | 'conversion_failed', message: string) {
    super(message);
    this.name = 'CardFileError';
  }
}

function invalidAvatar(message: string): never {
  throw new CardFileError('invalid_avatar', message);
}

function serializeCard(card: unknown): { text: string; name: string } {
  let text: string, copy: unknown;
  try { text = JSON.stringify(card); copy = JSON.parse(text); }
  catch { throw new CardFileError('invalid_card', 'The saved character card is not valid JSON.'); }
  const record = copy as { spec?: unknown; spec_version?: unknown; data?: { name?: unknown } } | null;
  if (!record || record.spec !== 'chara_card_v2' || record.spec_version !== '2.0' ||
      typeof record.data?.name !== 'string' || !record.data.name.trim()) {
    throw new CardFileError('invalid_card', 'A CCv2 character card with a name is required.');
  }
  if (encoder.encode(text).byteLength > MAX_CARD_BYTES) {
    throw new CardFileError('invalid_card', 'The saved character card is larger than 10 MiB.');
  }
  // Keep the serialized card intact: extensions and other unknown JSON fields matter.
  return { text, name: record.data.name };
}

function fileName(name: string): string {
  let safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/g, '').slice(0, 100);
  if (!safe || safe === '.' || safe === '..') safe = 'character';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
  return safe;
}

function startsWith(bytes: Uint8Array, magic: Uint8Array): boolean {
  return bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte);
}

/** Reject URLs and malformed/mislabeled data before any image decoder runs. */
export function decodeAvatarDataUrl(value: string): { mime: 'image/png' | 'image/jpeg' | 'image/webp'; bytes: Uint8Array } {
  if (typeof value !== 'string') invalidAvatar('The saved avatar must be a PNG, JPEG, or WebP base64 data URL.');
  if (value.length > Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + 64) {
    throw new CardFileError('avatar_too_large', 'The saved avatar must be at most 10 MiB.');
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) invalidAvatar('The saved avatar must be a PNG, JPEG, or WebP base64 data URL.');
  const mime = match[1] as 'image/png' | 'image/jpeg' | 'image/webp';
  let binary: string;
  try { binary = atob(match[2]); }
  catch { return invalidAvatar('The saved avatar contains invalid base64 data.'); }
  if (btoa(binary) !== match[2]) invalidAvatar('The saved avatar contains invalid base64 data.');
  if (binary.length > MAX_AVATAR_BYTES) throw new CardFileError('avatar_too_large', 'The saved avatar must be at most 10 MiB.');
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const isPng = startsWith(bytes, PNG_SIGNATURE);
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isWebp = bytes.length >= 16 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP';
  if (!(mime === 'image/png' ? isPng : mime === 'image/jpeg' ? isJpeg : isWebp)) {
    invalidAvatar('The saved avatar does not match its image type.');
  }
  return { mime, bytes };
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let text = '';
  for (let index = start; index < end; index++) text += String.fromCharCode(bytes[index]);
  return text;
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  crcTable[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
    invalidAvatar('The saved avatar dimensions are unsupported (maximum 40 megapixels and 16384 pixels per side).');
  }
}

function pngChunks(png: Uint8Array): Uint8Array[] {
  if (!startsWith(png, PNG_SIGNATURE)) invalidAvatar('The saved avatar is not a valid PNG.');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Uint8Array[] = [];
  let offset = PNG_SIGNATURE.length, sawHeader = false, sawData = false, sawEnd = false;
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const end = offset + length + 12;
    if (end > png.length) invalidAvatar('The saved PNG has a truncated image chunk.');
    const type = ascii(png, offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(png.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) {
      invalidAvatar('The saved PNG contains an invalid image chunk.');
    }
    if (!sawHeader && type !== 'IHDR') invalidAvatar('The saved PNG is missing its image header.');
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) invalidAvatar('The saved PNG has an invalid image header.');
      assertDimensions(view.getUint32(offset + 8), view.getUint32(offset + 12));
      sawHeader = true;
    }
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') {
      if (length !== 0 || !sawData || end !== png.length) invalidAvatar('The saved PNG has an invalid image ending.');
      sawEnd = true;
    }
    let oldCard = false;
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const data = png.subarray(offset + 8, end - 4);
      const separator = data.indexOf(0);
      const keyword = separator >= 0 ? ascii(data, 0, separator) : '';
      oldCard = keyword === 'chara' || keyword === 'ccv3';
    }
    if (!oldCard) chunks.push(png.subarray(offset, end));
    offset = end;
    if (sawEnd) break;
  }
  if (!sawEnd || offset !== png.length) invalidAvatar('The saved PNG is incomplete.');
  return chunks;
}

function base64Utf8(text: string): string {
  const bytes = encoder.encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function withCardMetadata(png: Uint8Array, text: string): Uint8Array {
  const chunks = pngChunks(png);
  const data = encoder.encode(`chara\0${base64Utf8(text)}`);
  const metadata = new Uint8Array(data.length + 12);
  const metadataView = new DataView(metadata.buffer);
  metadataView.setUint32(0, data.length);
  metadata.set(encoder.encode('tEXt'), 4);
  metadata.set(data, 8);
  metadataView.setUint32(metadata.length - 4, crc32(metadata.subarray(4, metadata.length - 4)));
  const parts = [PNG_SIGNATURE, ...chunks.slice(0, -1), metadata, chunks[chunks.length - 1]];
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

/** Preserves every PNG image chunk, replacing only previous card metadata. */
export function embedCardInPng(png: Uint8Array, card: unknown): Uint8Array {
  return withCardMetadata(png, serializeCard(card).text);
}

async function convertToPng(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  const blob = new Blob([bytes.slice().buffer], { type: mime });
  let source: ImageBitmap | HTMLImageElement | undefined;
  let objectUrl: string | undefined;
  try {
    if (typeof createImageBitmap === 'function') source = await createImageBitmap(blob);
    else {
      objectUrl = URL.createObjectURL(blob);
      const image = new Image();
      image.src = objectUrl;
      await image.decode();
      source = image;
    }
    const width = 'naturalWidth' in source ? source.naturalWidth : source.width;
    const height = 'naturalHeight' in source ? source.naturalHeight : source.height;
    assertDimensions(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable.');
    context.drawImage(source, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error('PNG encoding failed.')), 'image/png');
    });
    // Conversion keeps the decoded dimensions; there is no resize or external image request.
    if (png.size > MAX_AVATAR_BYTES) throw new CardFileError('avatar_too_large', 'The avatar becomes larger than 10 MiB as a PNG.');
    return new Uint8Array(await png.arrayBuffer());
  } catch (error) {
    if (error instanceof CardFileError) throw error;
    throw new CardFileError('conversion_failed', 'The saved avatar could not be converted locally. Import without its avatar only if you choose to.');
  } finally {
    if (source && 'close' in source) source.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

/**
 * No network access or character mutation. A supplied invalid avatar rejects:
 * callers must explicitly ask before retrying with null to omit that avatar.
 */
export async function createCardFile(card: unknown, avatarDataUrl?: string | null): Promise<File> {
  const { text, name } = serializeCard(card);
  const basename = fileName(name);
  if (avatarDataUrl == null) return new File([text], `${basename}.json`, { type: 'application/json', lastModified: 0 });
  const { mime, bytes } = decodeAvatarDataUrl(avatarDataUrl);
  const png = mime === 'image/png' ? bytes : await convertToPng(bytes, mime);
  const result = withCardMetadata(png, text);
  return new File([result.buffer as ArrayBuffer], `${basename}.png`, { type: 'image/png', lastModified: 0 });
}
