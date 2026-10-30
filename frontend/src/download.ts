/** Saves a blob as `filename` through a temporary download link. */
export const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking right after click() can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
};
