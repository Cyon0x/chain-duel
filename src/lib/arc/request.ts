import { ChainDuelError } from "../services/errors";
export async function readArcJson(request: Request): Promise<unknown> {
  const limit = 256 * 1024;
  if (Number(request.headers.get("content-length") ?? "0") > limit)
    throw new ChainDuelError("This request is too large.", "request_too_large", 413);
  if (!request.body) throw new ChainDuelError("A JSON request is required.", "invalid_request", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ChainDuelError("This request is too large.", "request_too_large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ChainDuelError("Send a valid JSON request.", "invalid_request", 400);
  }
}
