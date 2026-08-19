// Server-sent events parser shared by every provider adapter.
// The only hard requirement: a JSON payload split across chunk boundaries by the
// network must parse exactly as if it had arrived whole.

const DONE = Symbol('sse-done');

/**
 * @param {string} raw one event block, already newline-normalised
 * @returns {object|undefined|DONE} parsed data payload, or undefined to skip
 */
function parseEvent(raw) {
  const data = [];
  for (const line of raw.split('\n')) {
    if (line === '' || line[0] === ':') continue; // blank or comment/heartbeat
    const c = line.indexOf(':');
    const field = c === -1 ? line : line.slice(0, c);
    if (field !== 'data') continue; // event:/id:/retry: carry nothing we need
    let value = c === -1 ? '' : line.slice(c + 1);
    if (value[0] === ' ') value = value.slice(1);
    data.push(value);
  }
  if (data.length === 0) return undefined;
  const payload = data.join('\n');
  if (payload === '[DONE]') return DONE;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined; // a malformed keepalive must not kill a working stream
  }
}

/**
 * @param {ReadableStream<Uint8Array>} stream typically response.body
 * @yields {object} each event's parsed `data` JSON
 */
export async function* sseEvents(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });

      // A \r\n may be split across chunks; hold a dangling \r back.
      let tail = '';
      if (!done && buf.endsWith('\r')) {
        tail = '\r';
        buf = buf.slice(0, -1);
      }
      buf = buf.replace(/\r\n|\r/g, '\n');

      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const event = parseEvent(buf.slice(0, i));
        buf = buf.slice(i + 2);
        if (event === DONE) return;
        if (event !== undefined) yield event;
      }
      buf += tail;

      if (done) {
        const last = parseEvent(buf); // flush a trailing event with no blank line
        if (last !== undefined && last !== DONE) yield last;
        return;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

/** Test helper: a ReadableStream over `text`, emitted `chunkSize` bytes at a time. */
export function streamFromString(text, chunkSize = Infinity) {
  const bytes = new TextEncoder().encode(text);
  const size = Number.isFinite(chunkSize) ? Math.max(1, chunkSize) : bytes.length || 1;
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(i, (i += size)));
    },
  });
}
