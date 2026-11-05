import { Button, Spinner } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import PillSelect from '../components/ui/kit/PillSelect';
import type { NoiseProfile, NoiseRating } from './noiseProfiles';

/** What the measurements of the Analyse tab show (staff). */
export type NoiseViewState = 'active' | 'raw' | 'test' | 'draft' | 'none';

type NoiseProfileControlsProps = {
  /** The profiles of the shown device, newest first. */
  profiles: NoiseProfile[];
  /** Per profile: its rating for the loaded period. */
  ratings: ReadonlyMap<number, NoiseRating | null>;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** The profile tried out ("Anwenden") - not active for anyone else. */
  testedId: number | null;
  onTest: (id: number | null) => void;
  rawView: boolean;
  onRawViewChange: (raw: boolean) => void;
  view: NoiseViewState;
  busy: boolean;
  /** A draft is being edited. */
  editing: boolean;
  onCreate: () => void;
  onEdit: (profile: NoiseProfile) => void;
  onActivate: (profile: NoiseProfile) => void;
  onDeactivate: () => void;
  onDelete: (profile: NoiseProfile) => void;
  onDownload: (profile: NoiseProfile) => void;
};

const percent = (value: number) => `${Math.round(value * 100)} %`;

const SMALL = { fontSize: 12 } as const;

/**
 * Staff: the Störungsprofil of the shown device, above the first plot's
 * legend - pick a profile (with its rating for the loaded period), try it
 * ("Anwenden"), switch it active for everyone, edit it or make a new one
 * from the period; "Rohdaten" shows the values without any profile.
 */
const NoiseProfileControls = ({
  profiles,
  ratings,
  selectedId,
  onSelect,
  testedId,
  onTest,
  rawView,
  onRawViewChange,
  view,
  busy,
  editing,
  onCreate,
  onEdit,
  onActivate,
  onDeactivate,
  onDelete,
  onDownload,
}: NoiseProfileControlsProps) => {
  const { t } = useTranslation();
  const selected = profiles.find((profile) => profile.id === selectedId) ?? null;
  const active = profiles.find((profile) => profile.is_active) ?? null;
  const tested = profiles.find((profile) => profile.id === testedId) ?? null;
  const rating = selected ? ratings.get(selected.id) : null;

  const optionLabel = (profile: NoiseProfile) => {
    const score = ratings.get(profile.id)?.score;
    return [
      profile.name,
      score != null ? `${score} %` : null,
      profile.is_active ? t('noise_profile_active_badge') : null,
    ]
      .filter(Boolean)
      .join(' · ');
  };

  const viewLabel = {
    active: active ? t('noise_profile_view_active', { name: active.name }) : t('noise_profile_view_none'),
    none: t('noise_profile_view_none'),
    raw: t('noise_profile_view_raw'),
    test: t('noise_profile_view_test', { name: tested?.name ?? '' }),
    draft: t('noise_profile_view_draft'),
  }[view];

  return (
    <div className="d-flex flex-column align-items-end gap-1" data-testid="noise-profile-controls">
      <div className="d-flex flex-wrap justify-content-end align-items-center gap-2">
        <PillSelect
          label={t('noise_profile_label')}
          title={t('noise_profile_hint')}
          options={[
            { value: '', label: profiles.length ? t('noise_profile_choose') : t('noise_profile_empty') },
            ...profiles.map((profile) => ({ value: String(profile.id), label: optionLabel(profile) })),
          ]}
          value={selected ? String(selected.id) : ''}
          onChange={(value) => onSelect(value ? Number(value) : null)}
        />
        {selected && (
          <>
            <Button
              size="sm"
              variant={testedId === selected.id ? 'primary' : 'outline-primary'}
              aria-pressed={testedId === selected.id}
              className="py-0"
              style={SMALL}
              title={t('noise_profile_apply_hint')}
              disabled={busy || editing}
              onClick={() => onTest(testedId === selected.id ? null : selected.id)}
            >
              {testedId === selected.id ? t('noise_profile_apply_end') : t('noise_profile_apply')}
            </Button>
            {!selected.is_active && (
              <Button
                size="sm"
                variant="outline-success"
                className="py-0"
                style={SMALL}
                title={t('noise_profile_activate_hint')}
                disabled={busy || editing}
                onClick={() => onActivate(selected)}
              >
                {t('noise_profile_activate')}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline-secondary"
              className="py-0"
              style={SMALL}
              disabled={busy || editing}
              onClick={() => onEdit(selected)}
            >
              {t('noise_profile_edit')}
            </Button>
            <Button
              size="sm"
              variant="outline-secondary"
              className="py-0"
              style={SMALL}
              title={t('noise_profile_csv_hint')}
              onClick={() => onDownload(selected)}
            >
              {t('noise_profile_csv')}
            </Button>
            <Button
              size="sm"
              variant="outline-danger"
              className="py-0"
              style={SMALL}
              disabled={busy || editing}
              onClick={() => {
                if (window.confirm(t('noise_profile_delete_confirm', { name: selected.name }))) {
                  onDelete(selected);
                }
              }}
            >
              {t('noise_profile_delete')}
            </Button>
          </>
        )}
        {active && (
          <Button
            size="sm"
            variant="outline-warning"
            className="py-0"
            style={SMALL}
            title={t('noise_profile_deactivate_hint', { name: active.name })}
            disabled={busy || editing}
            onClick={onDeactivate}
          >
            {t('noise_profile_deactivate')}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline-primary"
          className="py-0"
          style={SMALL}
          title={t('noise_profile_new_hint')}
          disabled={busy || editing}
          onClick={onCreate}
        >
          {t('noise_profile_new')}
        </Button>
        <Button
          size="sm"
          variant={rawView ? 'dark' : 'outline-dark'}
          aria-pressed={rawView}
          className="py-0"
          style={SMALL}
          title={t('noise_profile_raw_hint')}
          disabled={editing}
          onClick={() => onRawViewChange(!rawView)}
        >
          {t('noise_profile_raw')}
        </Button>
        {busy && <Spinner size="sm" animation="border" className="text-muted" />}
      </div>
      <small className="text-muted text-end" data-testid="noise-profile-status">
        {viewLabel}
        {rating && (
          <span className="ms-2" title={t('noise_profile_rating_hint')}>
            ·{' '}
            {t('noise_profile_rating', {
              name: selected?.name ?? '',
              score: rating.score,
              fit: percent(rating.fit),
              effect: percent(rating.effect),
              before: rating.exceedBefore,
              after: rating.exceedAfter,
            })}
          </span>
        )}
      </small>
    </div>
  );
};

export default NoiseProfileControls;
