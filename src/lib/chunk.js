/**
 * Time-windowed chunking for the map-reduce pass over long videos.
 * Pure data; safe in the service worker and under `node --test`.
 *
 * @typedef {{t:number, d:number, text:string}} Cue
 * @typedef {{index:number, total:number, startT:number, endT:number, cues:Cue[]}} Chunk
 */

const charsOf = (cues) => cues.reduce((n, c) => n + String(c.text || '').length + 1, 0);

/**
 * Split cues into overlapping windows. Every input cue lands in at least one
 * chunk; consecutive chunks share `overlapSeconds` of tail so a sentence that
 * straddles a boundary is summarized whole at least once.
 *
 * @param {Cue[]} cues
 * @param {{maxChars?:number, windowSeconds?:number, overlapSeconds?:number}} [opts]
 * @returns {Chunk[]}
 */
export function chunkCues(cues, opts = {}) {
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 60000;
  const windowSeconds = Number(opts.windowSeconds) > 0 ? Number(opts.windowSeconds) : 480;
  const overlapSeconds = Number(opts.overlapSeconds) >= 0 ? Number(opts.overlapSeconds) : 30;

  const list = Array.isArray(cues) ? cues.filter((c) => c && typeof c.text === 'string') : [];
  if (!list.length) return [];

  /** @type {Cue[][]} */
  const groups = [];
  let cur = [];
  let chars = 0;
  let windowStart = Number.isFinite(list[0].t) ? list[0].t : 0;

  for (const cue of list) {
    const t = Number.isFinite(cue.t) ? cue.t : 0;
    const len = String(cue.text || '').length + 1;
    const overWindow = cur.length > 0 && t - windowStart >= windowSeconds;
    const overChars = cur.length > 0 && chars + len > maxChars;

    if (overWindow || overChars) {
      groups.push(cur);
      // Carry the trailing overlap forward — unless it would be the whole
      // chunk again, or would not leave room for new content.
      const cutoff = t - overlapSeconds;
      let tail = cur.filter((c) => (Number.isFinite(c.t) ? c.t : 0) >= cutoff);
      if (tail.length >= cur.length || charsOf(tail) + len > maxChars) tail = [];
      cur = tail;
      chars = charsOf(tail);
      windowStart = cur.length ? (Number.isFinite(cur[0].t) ? cur[0].t : 0) : t;
    }

    cur.push(cue);
    chars += len;
  }
  if (cur.length) groups.push(cur);

  return groups.map((g, i) => {
    const last = g[g.length - 1];
    return {
      index: i,
      total: groups.length,
      startT: Number.isFinite(g[0].t) ? g[0].t : 0,
      endT: (Number.isFinite(last.t) ? last.t : 0) + (Number.isFinite(last.d) ? last.d : 0),
      cues: g
    };
  });
}
