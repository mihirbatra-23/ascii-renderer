/** Saves a blob through a temporary object URL and an <a download> click. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in Safari/Firefox; give it time to start.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
