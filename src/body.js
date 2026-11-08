// Reads a request body, stopping as soon as it passes `limit` bytes, so an oversized upload
// is refused without being held in memory first. Used by every route that reads a body.

export class TooLarge extends Error {}

export async function readText(request, limit) {
  return new TextDecoder().decode(await readBytes(request, limit));
}

export async function readBytes(request, limit) {
  if (!request.body) return new Uint8Array();
  if (Number(request.headers.get('content-length')) > limit) throw new TooLarge();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
