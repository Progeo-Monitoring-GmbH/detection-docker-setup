import { type ReactNode, useState } from 'react';
import { Button, Card, Collapse, Spinner } from 'react-bootstrap';
import { XLg } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import PillSelect from '../components/ui/kit/PillSelect';
import { formatDate } from './dateFormat';
import {
  formatSpan,
  type NoiseProfile,
  type NoiseRating,
  type RatingLevel,
  ratingLevel,
  type RatingMeasure,
} from './noiseProfiles';

/** What the measurements of the Analyse tab show (staff). */
export type NoiseViewState = 'active' | 'test' | 'draft' | 'raw' | 'none';

/** The time span (ms) a new profile is made from. */
export type ProfileRange = { from: number; to: number };

type NoiseProfilePanelProps = {
  /** The shown device's name - a profile belongs to one device. */
  deviceName: string | null;
  /** The profiles of the shown device, newest first. */
  profiles: NoiseProfile[];
  /** Per profile: its rating for the loaded period. */
  ratings: ReadonlyMap<number, NoiseRating | null>;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** The profile tried out ("Anwenden") - not active for anyone else. */
  testedId: number | null;
  onTest: (id: number | null) => void;
  view: NoiseViewState;
  busy: boolean;
  /** The selected span (2nd / 3rd plot with S, or under the frame slider). */
  range: ProfileRange | null;
  onClearRange: () => void;
  onCreate: () => void;
  onEdit: (profile: NoiseProfile) => void;
  onActivate: (profile: NoiseProfile) => void;
  onDeactivate: () => void;
  onDelete: (profile: NoiseProfile) => void;
  onDownload: (profile: NoiseProfile) => void;
  /** The draft being edited - its editor and rating replace the selection's. */
  draftName: string | null;
  draftRating: NoiseRating | null;
  editor: ReactNode;
  /** Below everything: the thresholds (ThresholdMixerToggle). */
  thresholds?: ReactNode;
};

const SMALL = { fontSize: 12 } as const;

/** The traffic light's colours: text, background, border. */
const LEVEL_COLORS: Record<RatingLevel, { text: string; background: string; border: string }> = {
  good: { text: '#1e7b34', background: 'rgba(141, 193, 96, 0.2)', border: '#8dc160' },
  fair: { text: '#8a5a00', background: 'rgba(251, 188, 21, 0.2)', border: '#fbbc15' },
  poor: { text: '#b42318', background: 'rgba(220, 38, 38, 0.1)', border: 'rgba(220, 38, 38, 0.55)' },
};

const percent = (value: number) => `${Math.round(value * 100)} %`;

/** One big measure of a rating, in its traffic-light colour. */
const RatingTile = ({
  label,
  measure,
  value,
  text,
  hint,
}: {
  label: string;
  measure: RatingMeasure;
  value: number | null;
  text: string;
  hint: string;
}) => {
  const level = value == null ? null : ratingLevel(measure, value);
  const colors = level ? LEVEL_COLORS[level] : null;
  return (
    <div
      data-testid={`noise-rating-${measure}`}
      data-level={level ?? 'none'}
      title={hint}
      className="rounded-3 px-3 py-2"
      style={{
        flex: '1 1 160px',
        minWidth: 140,
        background: colors?.background ?? 'var(--progeo-surface)',
        border: `2px solid ${colors?.border ?? 'var(--progeo-warm-gray-2)'}`,
      }}
    >
      <div className="d-flex align-items-center gap-2 small fw-semibold text-uppercase" style={{ letterSpacing: 0.5 }}>
        <span
          aria-hidden="true"
          style={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: colors?.border ?? 'var(--progeo-warm-gray-3)',
            flexShrink: 0,
          }}
        />
        {label}
      </div>
      <div
        className="fw-bold"
        style={{
          fontSize: '2.75rem',
          lineHeight: 1.1,
          color: colors?.text ?? 'var(--progeo-warm-gray-4)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {text}
      </div>
    </div>
  );
};

/** Bewertung, Passung and Wirkung of a rating - big, as traffic lights. */
const NoiseRatingTiles = ({ rating }: { rating: NoiseRating | null }) => {
  const { t } = useTranslation();
  return (
    <div>
      <div className="d-flex flex-wrap gap-3">
        <RatingTile
          label={t('noise_profile_score')}
          measure="score"
          value={rating?.score ?? null}
          text={rating ? `${rating.score} %` : '–'}
          hint={t('noise_profile_score_hint')}
        />
        <RatingTile
          label={t('noise_profile_fit')}
          measure="fit"
          value={rating?.fit ?? null}
          text={rating ? percent(rating.fit) : '–'}
          hint={t('noise_profile_fit_hint')}
        />
        <RatingTile
          label={t('noise_profile_effect')}
          measure="effect"
          value={rating?.effect ?? null}
          text={rating ? percent(rating.effect) : '–'}
          hint={t('noise_profile_effect_hint')}
        />
      </div>
      {rating && (
        <div className="small text-muted mt-1" title={t('noise_profile_rating_hint')}>
          {t('noise_profile_rating_details', {
            before: rating.exceedBefore,
            after: rating.exceedAfter,
            count: rating.measurements,
          })}
        </div>
      )}
    </div>
  );
};

/**
 * Staff: the Störungsprofile of the shown device in their own, foldable
 * panel - pick one (rated for the loaded period), try it ("Anwenden"), switch
 * it active for everyone, edit it in its plot or make a new one from the
 * selected span; Bewertung, Passung and Wirkung big on top. The thresholds
 * the rating counts against can be loaded right here.
 */
const NoiseProfilePanel = ({
  deviceName,
  profiles,
  ratings,
  selectedId,
  onSelect,
  testedId,
  onTest,
  view,
  busy,
  range,
  onClearRange,
  onCreate,
  onEdit,
  onActivate,
  onDeactivate,
  onDelete,
  onDownload,
  draftName,
  draftRating,
  editor,
  thresholds = null,
}: NoiseProfilePanelProps) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const editing = draftName != null;
  const selected = profiles.find((profile) => profile.id === selectedId) ?? null;
  const active = profiles.find((profile) => profile.is_active) ?? null;
  const tested = profiles.find((profile) => profile.id === testedId) ?? null;
  // The draft's rating while editing, else the picked profile's.
  const rating = editing ? draftRating : selected ? (ratings.get(selected.id) ?? null) : null;
  const ratedName = editing ? draftName : (selected?.name ?? null);

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

  const scoreLevel = rating ? ratingLevel('score', rating.score) : null;

  return (
    <Card className="border-0 shadow-sm" data-testid="noise-profile-panel">
      <Card.Header className="bg-transparent border-0 pt-2 pb-1 d-flex flex-wrap align-items-center gap-2">
        <Button
          variant="link"
          className="p-0 text-decoration-none fw-semibold"
          style={{ color: 'var(--progeo-blue)' }}
          aria-expanded={open}
          aria-controls="analyse-noise-profile"
          onClick={() => setOpen((shown) => !shown)}
        >
          <span className="me-2">{open ? '▾' : '▸'}</span>
          {t('noise_profile_label')}
        </Button>
        {deviceName && <span className="small text-muted">{deviceName}</span>}
        {/* Folded: the rating and what is shown, in one line. */}
        {!open && rating && scoreLevel && (
          <span
            className="rounded-pill px-2 fw-semibold small"
            style={{
              color: LEVEL_COLORS[scoreLevel].text,
              background: LEVEL_COLORS[scoreLevel].background,
              border: `1px solid ${LEVEL_COLORS[scoreLevel].border}`,
            }}
          >
            {t('noise_profile_score')} {rating.score} %
          </span>
        )}
        <small className="text-muted ms-auto" data-testid="noise-profile-status">
          {viewLabel}
        </small>
        {busy && <Spinner size="sm" animation="border" className="text-muted" />}
      </Card.Header>
      <Collapse in={open}>
        <div id="analyse-noise-profile">
          <Card.Body className="pt-1 d-flex flex-column gap-3">
            {/* Pick, try, switch active, edit, download, delete. */}
            <div className="d-flex flex-wrap align-items-center gap-2" data-testid="noise-profile-controls">
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
            </div>

            {/* The span a new profile is made from - and how long it is. */}
            <div
              className="d-flex flex-wrap align-items-center gap-2 rounded-3 px-3 py-2 small"
              style={{ background: 'var(--progeo-surface)' }}
              data-testid="noise-profile-range"
            >
              {range ? (
                <>
                  <span className="fw-semibold">{t('noise_profile_range')}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {formatDate(range.from, 'dateTime')} – {formatDate(range.to, 'dateTime')}
                  </span>
                  <span
                    className="rounded-pill px-2 fw-semibold"
                    style={{ background: 'rgba(235, 99, 59, 0.15)', color: '#a3401f' }}
                    data-testid="noise-profile-range-length"
                  >
                    {formatSpan(range.to - range.from)}
                  </span>
                  <button
                    type="button"
                    className="btn btn-link p-0 text-muted lh-1"
                    title={t('noise_profile_range_clear')}
                    aria-label={t('noise_profile_range_clear')}
                    onClick={onClearRange}
                  >
                    <XLg size={11} />
                  </button>
                </>
              ) : (
                <span className="text-muted">{t('noise_profile_range_none')}</span>
              )}
              <Button
                size="sm"
                variant="primary"
                className="py-0 ms-auto"
                style={SMALL}
                title={t('noise_profile_new_hint')}
                disabled={busy || editing || !range}
                onClick={onCreate}
              >
                {t('noise_profile_new')}
              </Button>
            </div>

            <div>
              <div className="small text-muted mb-1">
                {ratedName ? t('noise_profile_rating_of', { name: ratedName }) : t('noise_profile_rating_none')}
              </div>
              <NoiseRatingTiles rating={rating} />
            </div>

            {editor}

            {thresholds}
          </Card.Body>
        </div>
      </Collapse>
    </Card>
  );
};

export default NoiseProfilePanel;
