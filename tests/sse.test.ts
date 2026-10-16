import { it, expect } from "vitest";
import { parseSse } from "../server/sse.js";
it("parses fragmented multiline CRLF UTF-8 and ignores comments or malformed frames", async () => {
  const text =
    ': heartbeat\r\n\r\ndata: {"type":"unknown",\r\ndata: "text":"café"}\r\n\r\ndata: invalid\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 3)
        c.enqueue(bytes.slice(i, i + 3));
      c.close();
    },
  });
  const output = [];
  for await (const v of parseSse(body)) output.push(v);
  expect(output).toEqual([{ type: "unknown", text: "café" }]);
});
it("rejects oversized frames", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("data: " + "x".repeat(140000)));
      c.close();
    },
  });
  await expect(
    (async () => {
      for await (const _ of parseSse(body)) {
      }
    })(),
  ).rejects.toThrow("SSE frame too large");
});
