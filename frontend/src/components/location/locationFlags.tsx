import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { BellSlashFill, Trash3Fill } from 'react-bootstrap-icons';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { staffFlags } from '../../main/access';
import { repeatedTestId } from '../../testIds';
import './locationFlags.css';

/**
 * A location is "switched off" when its notifications are disabled
 * (ProgeoLocation.notifications_disabled) or staff marked it for the purge
 * script (purgeable). Every table with a location per row shows that the
 * same way, for staff only: discreet stripes (LOCATION_OFF_CLASS) and an
 * icon per flag (LocationFlagIcons).
 *
 * The flags come from one store: GET /v1/location/flags/?ids=... (batched,
 * once per id) - and every toggle (notification switch, purge mark) writes
 * its new value here, so all tables follow at once.
 */
export type LocationFlags = {
  notifications_disabled: boolean | null;
  purgeable: boolean | null;
};

export const LOCATION_OFF_CLASS = 'location-row-off';

export const isLocationOff = (flags: Partial<LocationFlags> | null | undefined) =>
  flags?.notifications_disabled === true || flags?.purgeable === true;

const FLAGS_URL = '/v1/location/flags/';
/** Ids per request (the backend allows 500). */
const BATCH = 200;

const store = new Map<number, LocationFlags>();
const requested = new Set<number>();
const queued = new Set<number>();
const listeners = new Set<() => void>();
let version = 0;
type Auth = ReturnType<typeof useAuth>;

let flushAuth = null as unknown as Auth;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const notify = () => {
  version += 1;
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getVersion = () => version;

const flush = () => {
  flushTimer = null;
  const ids = [...queued];
  queued.clear();
  for (let start = 0; start < ids.length; start += BATCH) {
    const batch = ids.slice(start, start + BATCH);
    void axiosConfig.perform_get(
      flushAuth,
      `${FLAGS_URL}?ids=${batch.join(',')}`,
      (response) => {
        const flags = (response?.data?.flags ?? {}) as Record<string, LocationFlags>;
        batch.forEach((id) => {
          if (!store.has(id)) {
            store.set(id, flags[String(id)] ?? { notifications_disabled: null, purgeable: null });
          }
        });
        notify();
      },
      // Failed: no stripes - asked again on the next page visit.
      () => batch.forEach((id) => requested.delete(id)),
    );
  }
};

const request = (auth: Auth, ids: number[]) => {
  ids.forEach((id) => {
    requested.add(id);
    queued.add(id);
  });
  flushAuth = auth;
  // Every table of a page asks in the same tick: one request for all of them.
  flushTimer ??= setTimeout(flush, 0);
};

/** A flag changed on the page (a toggle answered): every table follows. */
export const setLocationFlags = (id: number, patch: Partial<LocationFlags>) => {
  const current = store.get(id) ?? { notifications_disabled: null, purgeable: null };
  store.set(id, { ...current, ...patch });
  requested.add(id);
  notify();
};

/** Tests: forget everything. */
export const resetLocationFlags = () => {
  store.clear();
  requested.clear();
  queued.clear();
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  notify();
};

/**
 * The flags of `ids` (staff only - everyone else gets null): loaded once per
 * id, kept for the visit. `flagsOf(id)` is null while unknown.
 */
export const useLocationFlags = (ids: ReadonlyArray<number | null | undefined>) => {
  const auth = useAuth();
  const staff = staffFlags(auth?.user).isStaffOrSuperuser;
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const wanted = [...new Set(ids.filter((id): id is number => typeof id === 'number' && Number.isFinite(id)))];
  const key = wanted.sort((a, b) => a - b).join(',');

  useEffect(() => {
    if (!staff || !key) {
      return;
    }
    const missing = key.split(',').map(Number).filter((id) => !requested.has(id));
    if (missing.length) {
      request(auth, missing);
    }
    // `auth` changes identity with every navigation - the ids decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff, key]);

  const flagsOf = (id: number | null | undefined): LocationFlags | null =>
    staff && id != null ? (store.get(id) ?? null) : null;
  return {
    flagsOf,
    isOff: (id: number | null | undefined) => isLocationOff(flagsOf(id)),
  };
};

/**
 * The conditional row style of a react-data-table-component table. Put it
 * FIRST in conditionalRowStyles: the table keeps the style of the last
 * matching rule (classes add up), so a later severity colour survives.
 */
export const locationOffRowStyle = <T,>(isOff: (row: T) => boolean) => ({
  when: isOff,
  classNames: [LOCATION_OFF_CLASS],
});

/** The icons of a switched-off location (none otherwise) - next to its name. */
export const LocationFlagIcons = ({ flags, testKey }: { flags: LocationFlags | null; testKey: string | number }) => {
  const { t } = useTranslation();
  if (!isLocationOff(flags)) {
    return null;
  }
  return (
    <span className="location-flag-icons" {...repeatedTestId('location-flag-icons', testKey)}>
      {flags?.notifications_disabled === true && (
        <BellSlashFill size={11} title={t('location_flag_notifications_off')} aria-label={t('location_flag_notifications_off')} />
      )}
      {flags?.purgeable === true && (
        <Trash3Fill size={11} title={t('location_flag_purgeable')} aria-label={t('location_flag_purgeable')} />
      )}
    </span>
  );
};
