/// <reference lib="webworker" />

const hexDigest = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

self.addEventListener('message', async (event: MessageEvent<{ file: File }>) => {
  try {
    const buffer = await event.data.file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    self.postMessage({ hash: hexDigest(digest) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});

export {};
