/**
 * Gives the event loop a turn between the frames of a long export, so input, rendering and Cancel
 * are handled while it runs. scheduler.yield() resumes ahead of other queued tasks; elsewhere a
 * MessageChannel round trip is a macrotask without setTimeout's 4 ms clamp.
 */
export function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
