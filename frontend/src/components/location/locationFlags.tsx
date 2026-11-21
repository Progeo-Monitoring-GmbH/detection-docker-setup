import { useEffect, useSyncExternalStore, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useInRouterContext } from 'react-router';
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
 *
 * The same store carries the readiness score (0-100, the checklist of
 * /checklist/location/): LocationFlagIcons shows it next to the name as a
 * badge linking to the checklist.
 */
export type LocationFlags = {
  /** The location - set by the store (the badge links to its checklist). */
  id?: number;
  notifications_disabled: boolean | null;
  purgeable: boolean | null;
  /** 0-100, null: never checked. */
  readiness_score?: number | null;
};

export type ReadinessLevel = 'ready' | 'almost' | 'progress' | 'open';

/** Like the backend's location_readiness.LEVELS. */
export const readinessLevel = (score: number): ReadinessLevel =>
  score >= 100 ? 'ready' : score >= 80 ? 'almost' : score >= 50 ? 'progress' : 'open';

const checklistPath = (locationId: number) => `/checklist/location/?location=${locationId}`;

export const LOCATION_OFF_CLASS = 'location-row-off';

export const isLocationOff = (flags: Partial<LocationFlags> | null | undefined) =>
  flags?.notifications_disabled === true || flags?.purgeable === true;

/** Marked for the purge script: red stripes instead of the discreet grey ones. */
export const LOCATION_PURGEABLE_CLASS = 'location-row-purgeable';

/**
 * The row class of a location in the location lists (overview, Verwaltung):
 * purgeable -> red stripes, otherwise switched off -> grey stripes, else ''.
 * Exclusive, so the two stripe patterns never stack.
 */
export const locationRowClass = (flags: Partial<LocationFlags> | null | undefined): string => {
  if (flags?.purgeable === true) {
    return LOCATION_PURGEABLE_CLASS;
  }
  return isLocationOff(flags) ? LOCATION_OFF_CLASS : '';
};

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
            store.set(id, { id, ...(flags[String(id)] ?? { notifications_disabled: null, purgeable: null }) });
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
  store.set(id, { ...current, ...patch, id });
  requested.add(id);
  notify();
};

/**
 * Flags a list already received with its rows (the Verwaltung's
 * admin_overview): stored at once - one notification - and never asked for
 * again. Ids already in the store keep their (possibly newer, toggled) value.
 */
export const seedLocationFlags = (rows: ReadonlyArray<Partial<LocationFlags> & { id: number }>) => {
  let changed = false;
  rows.forEach((row) => {
    requested.add(row.id);
    if (!store.has(row.id)) {
      store.set(row.id, {
        id: row.id,
        notifications_disabled: row.notifications_disabled ?? null,
        purgeable: row.purgeable ?? null,
        readiness_score: row.readiness_score ?? null,
      });
      changed = true;
    }
  });
  if (changed) {
    notify();
  }
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

/**
 * Like locationOffRowStyle, but purgeable rows get the red stripes
 * (locationRowClass) - two exclusive rules, put them FIRST as well.
 */
export const locationFlagRowStyles = <T,>(flagsOfRow: (row: T) => LocationFlags | null) => [
  {
    when: (row: T) => locationRowClass(flagsOfRow(row)) === LOCATION_PURGEABLE_CLASS,
    classNames: [LOCATION_PURGEABLE_CLASS],
  },
  {
    when: (row: T) => locationRowClass(flagsOfRow(row)) === LOCATION_OFF_CLASS,
    classNames: [LOCATION_OFF_CLASS],
  },
];

// The badge sits in clickable rows - opening the checklist must not also
// select the row.
const stopRowClick = (event: MouseEvent) => event.stopPropagation();

/**
 * The readiness score as a small coloured badge (nothing while unknown) -
 * a link to the location's checklist when `locationId` is given and the
 * page has a router.
 */
export const ReadinessBadge = ({
  score,
  locationId,
  testKey,
  className,
}: {
  score: number | null | undefined;
  locationId?: number | null;
  testKey: string | number;
  className?: string;
}) => {
  const { t } = useTranslation();
  const inRouter = useInRouterContext();
  if (score == null) {
    return null;
  }
  const props = {
    className: ['readiness-badge', `readiness-badge--${readinessLevel(score)}`, className].filter(Boolean).join(' '),
    title: t('readiness_badge_title', { score }),
    'aria-label': t('readiness_badge_title', { score }),
    ...repeatedTestId('readiness-badge', testKey),
  };
  return inRouter && locationId != null ? (
    <Link to={checklistPath(locationId)} onClick={stopRowClick} {...props}>
      {score}
    </Link>
  ) : (
    <span {...props}>{score}</span>
  );
};

/** The readiness score (staff) and the icons of a switched-off location - next to its name. */
export const LocationFlagIcons = ({ flags, testKey }: { flags: LocationFlags | null; testKey: string | number }) => {
  const { t } = useTranslation();
  const score = flags?.readiness_score ?? null;
  if (!isLocationOff(flags) && score == null) {
    return null;
  }
  return (
    <span className="location-flag-icons" {...repeatedTestId('location-flag-icons', testKey)}>
      <ReadinessBadge score={score} locationId={flags?.id} testKey={testKey} />
      {flags?.notifications_disabled === true && (
        <BellSlashFill size={11} title={t('location_flag_notifications_off')} aria-label={t('location_flag_notifications_off')} />
      )}
      {flags?.purgeable === true && (
        <Trash3Fill size={11} title={t('location_flag_purgeable')} aria-label={t('location_flag_purgeable')} />
      )}
    </span>
  );
};
