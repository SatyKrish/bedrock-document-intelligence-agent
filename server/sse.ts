// SSE boundaries, multiline data, CRLF and fragmented UTF-8 are handled;
// unknown event types are intentionally ignored by consumers.
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    lines: string[] = [];
  let size = 0;
  const frame = () => {
    const data = lines
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    lines = [];
    size = 0;
    if (!data || data === "[DONE]") return;
    try {
      return JSON.parse(data);
    } catch {
      return;
    }
  };
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 131072) throw Error("SSE frame too large");
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, "");
        buffer = buffer.slice(i + 1);
        if (!line) {
          const event = frame();
          if (event !== undefined) yield event;
        } else {
          size += line.length;
          if (size > 131072) throw Error("SSE frame too large");
          lines.push(line);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
