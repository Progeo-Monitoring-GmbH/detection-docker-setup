import { useMemo } from 'react';
import { Badge } from 'react-bootstrap';
import { Typeahead } from 'react-bootstrap-typeahead';
import 'react-bootstrap-typeahead/css/Typeahead.css';
import 'react-bootstrap-typeahead/css/Typeahead.bs5.css';
import { useTranslation } from 'react-i18next';
import { getProjectTypeLabel } from '../../main/projectType';
import {
  locationAddressLine,
  locationLabel,
  matchesLocationSearch,
  type SearchableLocation,
} from './locationSearch';

/** A location the picker can show - /v1/location/min/ rows and the like.
 * project_type is the choice value or an already resolved label. */
export type PickableLocation = SearchableLocation & {
  project_type?: number | string | null;
};

type LocationPickerProps<T extends PickableLocation> = {
  /** DOM id of the input (required by the typeahead for a11y). */
  id: string;
  locations: T[];
  /** The selected location's `valueKey` (null: nothing selected). */
  value: number | null;
  /** Which field `value` refers to: the location pk (default) or its
   * project id (the measure_points endpoints address locations by it). */
  valueKey?: 'id' | 'project_id';
  onChange: (location: T | null) => void;
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Show the selected location's address and product below the input. */
  showDetails?: boolean;
};

/**
 * Searchable single-location picker: matches every word of the query against
 * name, address, postcode, city, country, manager, contact and project id
 * (see locationSearch.ts), lists name, project id, product and address.
 */
const LocationPicker = <T extends PickableLocation>({
  id,
  locations,
  value,
  valueKey = 'id',
  onChange,
  loading = false,
  disabled = false,
  placeholder,
  showDetails = true,
}: LocationPickerProps<T>) => {
  const { t } = useTranslation();

  const sorted = useMemo(
    () =>
      [...locations].sort((a, b) =>
        locationLabel(a).localeCompare(locationLabel(b)),
      ),
    [locations],
  );
  const selected =
    value === null
      ? null
      : (locations.find((location) => location[valueKey] === value) ?? null);

  const productLabel = (location: T) =>
    typeof location.project_type === 'string'
      ? location.project_type
      : location.project_type != null
        ? getProjectTypeLabel(t, location.project_type)
        : '';

  return (
    <div>
      <Typeahead
        id={id}
        options={sorted}
        labelKey={(option) => locationLabel(option as T)}
        filterBy={(option, state) =>
          matchesLocationSearch(option as T, state.text)
        }
        renderMenuItemChildren={(option) => {
          const location = option as T;
          const product = productLabel(location);
          return (
            <div className="d-flex flex-column lh-sm py-1">
              <span className="text-truncate">
                <strong>
                  {location.name || location.address || 'Location'}
                </strong>
                {location.project_id != null && (
                  <span className="text-muted small ms-2">
                    #{location.project_id}
                  </span>
                )}
                {product && (
                  <Badge bg="light" text="dark" className="ms-2 fw-normal">
                    {product}
                  </Badge>
                )}
              </span>
              <span className="small text-muted text-truncate">
                {[
                  locationAddressLine(location),
                  location.country,
                  location.manager,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </span>
            </div>
          );
        }}
        selected={selected ? [selected] : []}
        onChange={(selection) =>
          onChange((selection[0] as T | undefined) ?? null)
        }
        placeholder={
          loading
            ? t('location_picker_loading')
            : !locations.length
              ? t('location_picker_empty')
              : (placeholder ?? t('location_picker_placeholder'))
        }
        emptyLabel={t('location_picker_no_match')}
        paginationText={t('location_picker_more')}
        disabled={disabled || loading || !locations.length}
        maxResults={50}
        paginate
        clearButton
        highlightOnlyResult
      />

      {showDetails && selected && (
        <div className="small text-muted mt-1">
          {[
            locationAddressLine(selected),
            selected.country,
            productLabel(selected),
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
    </div>
  );
};

export default LocationPicker;
