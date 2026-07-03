import { EventEmitter } from 'node:events';

// Live output hub for docker operations. Each project has at most one active
// operation (enforced by the per-project lock), so we keep one buffer per
// project and let SSE subscribers replay it on connect + stream new chunks.
const bus = new EventEmitter();
bus.setMaxListeners(0);

const MAX_LINES = 4000;
const active = new Map(); // projectId -> { action, lines: string[], done, ok }

export function startOp(projectId, action) {
  active.set(projectId, { action, lines: [], done: false, ok: null });
  bus.emit(projectId, { type: 'start', action });
}

export function appendOp(projectId, chunk) {
  const op = active.get(projectId);
  if (op) {
    op.lines.push(chunk);
    if (op.lines.length > MAX_LINES) op.lines.shift();
  }
  bus.emit(projectId, { type: 'data', chunk });
}

export function endOp(projectId, ok, message) {
  const op = active.get(projectId);
  if (op) { op.done = true; op.ok = ok; }
  bus.emit(projectId, { type: 'end', ok, message });
}

export function currentOp(projectId) {
  return active.get(projectId) || null;
}

export function subscribe(projectId, listener) {
  bus.on(projectId, listener);
  return () => bus.off(projectId, listener);
}

/** Run fn with an operation log context; fn receives an onData(chunk) sink. */
export async function withOpLog(projectId, action, fn) {
  startOp(projectId, action);
  try {
    const out = await fn((chunk) => appendOp(projectId, chunk));
    endOp(projectId, true);
    return out;
  } catch (err) {
    appendOp(projectId, `\n[failed] ${err.message}\n`);
    endOp(projectId, false, err.message);
    throw err;
  }
}
