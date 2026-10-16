// Never buffer an unbounded remote metadata/report body before enforcing its limit.
export async function responseBytes(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.body) throw Error("Empty HTTP response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw Error("HTTP response exceeds bounded contract");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function responseJson(
  response: Response,
  maxBytes = 1024 * 1024,
): Promise<any> {
  return JSON.parse((await responseBytes(response, maxBytes)).toString("utf8"));
}
