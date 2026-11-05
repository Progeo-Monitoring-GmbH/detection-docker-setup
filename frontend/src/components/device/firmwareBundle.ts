/** A flash bundle the server holds (firmware.list_bundles, newest first). */
export type FirmwareBundle = {
  id: string;
  release: string | null;
  firmware: string | null;
  created: string | null;
  channels: string[];
  /** Channels whose "latest" it is. */
  latest_in: string[];
};

// "v1.0.0_fw-v1.6.1-tls-lua53": the bundle release, then the firmware.
const BUNDLE_ID = /^(v?\d+(?:\.\d+)*)_fw-(v?\d+(?:\.\d+)*)/i;
// The firmware's version number without its build suffix ("v1.6.1-tls-lua53" -> "v1.6.1").
const VERSION = /^v?\d+(?:\.\d+)*/i;

/** "v1.0.0 (FW: v1.6.1)" - release and firmware version of a bundle, taken
 * from its fields, else from its id; the id itself when neither fits. */
export const bundleVersionLabel = (bundle: Pick<FirmwareBundle, 'id' | 'release' | 'firmware'>) => {
  const fromId = BUNDLE_ID.exec(bundle.id);
  const release = bundle.release?.trim() || fromId?.[1];
  const firmware = VERSION.exec(bundle.firmware?.trim() ?? '')?.[0] || fromId?.[2];
  if (!release) {
    return bundle.id;
  }
  return firmware ? `${release} (FW: ${firmware})` : release;
};
