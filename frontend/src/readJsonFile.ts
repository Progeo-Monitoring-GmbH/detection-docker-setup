/**
 * Reads the first of `files` as JSON (an import the user chose): the parsed
 * value goes to `onPayload` with the file's name; a file that is no JSON to
 * `onInvalid`. Nothing happens without a file.
 */
export const readJsonFile = (
  files: FileList | null,
  onPayload: (payload: unknown, fileName: string) => void,
  onInvalid: () => void,
) => {
  if (!files || files.length === 0) {
    return;
  }
  const file = files[0];
  const reader = new FileReader();
  reader.onload = () => {
    let payload: unknown;
    try {
      payload = JSON.parse(String(reader.result));
    } catch {
      onInvalid();
      return;
    }
    onPayload(payload, file.name);
  };
  reader.readAsText(file);
};
