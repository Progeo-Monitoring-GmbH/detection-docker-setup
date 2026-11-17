import type { ReactNode } from 'react';
import FavoriteStar from '../../main/FavoriteStar';
import { repeatedTestId } from '../../testIds';
import { LocationFlagIcons, type LocationFlags } from './locationFlags';
import './locationList.css';

/**
 * The shared cells of the location lists - the locations overview
 * (LocationsOverview) and the Verwaltung (LocationVerwaltungView) - so both
 * tables look the same: compact rows, a bold first line and a small muted
 * second line instead of tall wrapped cells. Styles: locationList.css
 * (wrap a table in LOCATION_LIST_CLASS for the compact rows).
 */
export const LOCATION_LIST_CLASS = 'location-list';

type AddressParts = {
  address?: string | null;
  plz?: string | null;
  city?: string | null;
};

/** "Hauptstr. 1, 12345 Berlin" - the parts that exist, '' without any. */
export const locationAddressLine = ({ address, plz, city }: AddressParts): string => {
  const place = [plz?.trim(), city?.trim()].filter(Boolean).join(' ');
  return [address?.trim(), place].filter(Boolean).join(', ');
};

/** A measurement this recent counts as "online" (green) in the lists. */
export const RECENT_MEASUREMENT_HOURS = 24;

/** Is `timestamp` within RECENT_MEASUREMENT_HOURS before `now`? */
export const isRecentMeasurement = (timestamp: string | null | undefined, now: number = Date.now()): boolean => {
  if (!timestamp) {
    return false;
  }
  const ms = Date.parse(timestamp);
  return !Number.isNaN(ms) && now - ms <= RECENT_MEASUREMENT_HOURS * 3600 * 1000;
};

/** A bold first line and an optional muted second line, both ellipsised. */
export const TwoLineCell = ({
  primary,
  secondary,
  title,
  plain = false,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  /** Tooltip with the full text - the lines are cut off when narrow. */
  title?: string;
  /** A normal-weight first line (contact, owner) instead of the bold name. */
  plain?: boolean;
}) => (
  <span className={plain ? 'location-list-lines location-list-lines--plain' : 'location-list-lines'} title={title}>
    <span className="location-list-primary">{primary}</span>
    {secondary ? <span className="location-list-secondary">{secondary}</span> : null}
  </span>
);

/**
 * The object cell: favorite star, the staff flags (readiness badge,
 * switched-off icons) and the name, with the address as the second line.
 * `name` may be a link (Verwaltung) - plain text otherwise.
 */
export const LocationNameCell = ({
  locationId,
  name,
  subline,
  flags,
  testKey,
}: {
  locationId: number;
  name: ReactNode;
  subline?: string;
  flags: LocationFlags | null;
  testKey: string | number;
}) => (
  <span className="location-list-name-cell" {...repeatedTestId('location-list-name', testKey)}>
    <FavoriteStar locationId={locationId} size={18} />
    <TwoLineCell
      primary={
        <>
          <LocationFlagIcons flags={flags} testKey={testKey} />
          {name}
        </>
      }
      secondary={subline}
      title={subline || undefined}
    />
  </span>
);
