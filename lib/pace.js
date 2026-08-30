// Request pacing and retry.
//
// The old build used a fixed delay chosen once at install time — a perfectly even
// 10.000s interval, which is a cleaner machine signature than a jittered short one,
// and which never adapted when Instagram actually pushed back. This starts fast,
// jitters every wait, and backs off only when told to.

export const MIN_DELAY_MS = 800;
export const MAX_DELAY_MS = 60000;

export function jitter(ms, spread = 0.4) {
  const delta = ms * spread;
  return Math.max(MIN_DELAY_MS, Math.round(ms - delta + Math.random() * delta * 2));
}

export class Pacer {
  constructor(baseMs) {
    this.base = Math.max(MIN_DELAY_MS, baseMs);
    this.current = this.base;
  }

  // Wait between successful batches.
  get delay() {
    return jitter(this.current);
  }

  // Instagram pushed back: double the spacing, capped.
  slowDown() {
    this.current = Math.min(this.current * 2, MAX_DELAY_MS);
    return this.current;
  }

  // A clean batch: drift back toward base rather than snapping, so one good
  // response after a 429 doesn't immediately re-provoke it.
  speedUp() {
    this.current = Math.max(this.base, Math.round(this.current * 0.8));
    return this.current;
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new AbortError());
    }, { once: true });
  });
}

export class AbortError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'AbortError';
  }
}

// A response that will never succeed on retry — don't burn attempts on it.
export class FatalError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'FatalError';
    this.kind = kind; // 'auth' | 'notfound' | 'shape'
    this.fatal = true;
  }
}

// The old code did `catch (err) { break; }` and then reported success. One blip at
// request 60 of 100 silently truncated the run. Retry, and if we genuinely can't
// continue, say so loudly rather than calling a partial list complete.
export async function withRetry(fn, { attempts = 5, signal, onRetry } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new AbortError();
    try {
      return await fn(attempt);
    } catch (err) {
      if (err instanceof AbortError || err.fatal) throw err;
      lastErr = err;
      if (attempt === attempts) break;
      const wait = jitter(Math.min(2000 * 2 ** (attempt - 1), MAX_DELAY_MS));
      onRetry?.({ attempt, wait, error: err });
      await sleep(wait, signal);
    }
  }
  throw lastErr;
}
