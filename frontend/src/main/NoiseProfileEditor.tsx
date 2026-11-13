import { type KeyboardEvent, useState } from 'react';
import { Button, Form, Spinner } from 'react-bootstrap';
import { ArrowCounterclockwise } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { announceKey } from '../components/ui/KeyHints';
import { formatDate } from './dateFormat';
import { describeMaskChange, formatSpan, type MaskChange, type NoiseProfileDraft } from './noiseProfiles';
import NoiseProfilePlot from './NoiseProfilePlot';
import './NoiseProfile.css';

type Masks = Pick<NoiseProfileDraft, 'mask_e' | 'mask_w'>;

type NoiseProfileEditorProps = {
  draft: NoiseProfileDraft;
  onChange: (draft: NoiseProfileDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  /** The plots show the draft applied (else the raw values with its masks as lines). */
  preview: boolean;
  onPreviewChange: (preview: boolean) => void;
  /** A raw measurement's EP / WP - dashed lines in the profile plot. */
  reference?: { ep: number[]; wp: number[] } | null;
};

/** A manual change: what it did, and the masks before it (for undo). */
type HistoryEntry = { change: MaskChange; before: Masks };


/** Ctrl / ⌘ + Z - except in a text field, which has its own undo. */
const isUndoKey = (event: KeyboardEvent<HTMLElement>) =>
  (event.ctrlKey || event.metaKey) &&
  !event.shiftKey &&
  !event.altKey &&
  event.key.toLowerCase() === 'z' &&
  !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement);

/**
 * Staff: a Störungsprofil being made (from the minimum EP / WP of the
 * selected period) or edited - its name and its masks as a plot whose values
 * are dragged up and down. Every manual change is listed next to
 * "Speichern" and can be undone (button, Strg + Z). Saved only with
 * "Speichern"; meanwhile the measurements preview it.
 */
const NoiseProfileEditor = ({
  draft,
  onChange,
  onSave,
  onCancel,
  saving,
  preview,
  onPreviewChange,
  reference = null,
}: NoiseProfileEditorProps) => {
  const { t } = useTranslation();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const sensors = Math.max(draft.mask_e.length, draft.mask_w.length);
  const sumE = draft.mask_e.reduce((sum, value) => sum + value, 0);
  const sumW = draft.mask_w.reduce((sum, value) => sum + value, 0);

  const changeMasks = (masks: Masks) => {
    const before = { mask_e: draft.mask_e, mask_w: draft.mask_w };
    const change = describeMaskChange(before, masks);
    if (!change) {
      return;
    }
    setHistory((entries) => [...entries, { change, before }]);
    onChange({ ...draft, ...masks });
  };

  const undo = () => {
    const last = history[history.length - 1];
    if (!last) {
      return;
    }
    setHistory((entries) => entries.slice(0, -1));
    onChange({ ...draft, ...last.before });
    announceKey('undo');
  };

  // Back to the masks the editing started with.
  const undoAll = () => {
    if (!history.length) {
      return;
    }
    onChange({ ...draft, ...history[0].before });
    setHistory([]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isUndoKey(event) && history.length) {
      event.preventDefault();
      undo();
    }
  };

  const seriesLabel = (change: MaskChange) =>
    change.series === 'both' ? 'EP + WP' : change.series === 'ep' ? 'EP' : 'WP';
  const sensorsLabel = (change: MaskChange) =>
    change.count === 1
      ? t('noise_profile_change_sensor', { sensor: change.first })
      : t('noise_profile_change_sensors', { first: change.first, last: change.last, count: change.count });
  const valuesLabel = (change: MaskChange) =>
    `${change.count === 1 ? '' : 'Ø '}${change.before} → ${change.after}`;

  return (
    <div
      className="rounded-3 p-3 noise-editor"
      data-testid="noise-profile-editor"
      onKeyDown={onKeyDown}
    >
      <div className="d-flex flex-wrap align-items-end gap-3 mb-3">
        <Form.Group className="noise-editor-name">
          <Form.Label className="small fw-semibold mb-1">{t('noise_profile_name')}</Form.Label>
          <Form.Control
            size="sm"
            value={draft.name}
            maxLength={100}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            data-testid="noise-profile-editor-name"
          />
        </Form.Group>
        <div className="small text-muted">
          {draft.source_from && (
            <div data-testid="noise-profile-editor-source">
              {t('noise_profile_source', {
                count: draft.source_count,
                from: formatDate(draft.source_from, 'dateTime'),
                to: draft.source_to ? formatDate(draft.source_to, 'dateTime') : t('noise_profile_now'),
              })}
              {draft.source_to &&
                ` (${formatSpan(new Date(draft.source_to).getTime() - new Date(draft.source_from).getTime())})`}
            </div>
          )}
          <div data-testid="noise-profile-editor-sums">{t('noise_profile_sums', { sumE, sumW, sensors })}</div>
        </div>
        <Form.Check
          type="switch"
          id="noise-profile-preview"
          data-testid="noise-profile-editor-preview"
          className="small ms-auto"
          label={t('noise_profile_preview')}
          title={t('noise_profile_preview_hint')}
          checked={preview}
          onChange={(event) => onPreviewChange(event.target.checked)}
        />
      </div>

      <NoiseProfilePlot
        mask_e={draft.mask_e}
        mask_w={draft.mask_w}
        reference={reference}
        onChange={changeMasks}
        extraKeyHints={[{ id: 'undo', keys: [t('key_ctrl'), 'Z'], label: t('key_hint_undo') }]}
      />

      {/* The manual changes, newest first - next to Speichern. */}
      <div className="d-flex gap-3 flex-wrap align-items-stretch mt-3">
        <div
          data-testid="noise-profile-changes"
          className="noise-editor-changes"
        >
          <div className="fw-semibold mb-1" data-testid="noise-profile-changes-count">
            {t('noise_profile_changes', { count: history.length })}
          </div>
          {history.length === 0 ? (
            <div className="text-muted" data-testid="noise-profile-no-changes">
              {t('noise_profile_no_changes')}
            </div>
          ) : (
            [...history].reverse().map((entry, index) => (
              <div
                key={history.length - index}
                className="d-flex align-items-center gap-2 noise-editor-change"
                data-testid="noise-profile-change"
                data-test-key={history.length - index}
              >
                <span className="text-muted noise-editor-change-index">
                  {history.length - index}.
                </span>
                <span className="fw-semibold">{seriesLabel(entry.change)}</span>
                <span>{sensorsLabel(entry.change)}</span>
                <span className="text-muted ms-auto noise-profile-tabular">
                  {valuesLabel(entry.change)}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="d-flex flex-column gap-2 justify-content-end noise-editor-actions">
          <Button
            size="sm"
            variant="primary"
            disabled={saving || !draft.name.trim() || !sensors}
            onClick={onSave}
            data-testid="noise-profile-editor-save"
          >
            {saving && <Spinner size="sm" animation="border" className="me-1" />}
            {t('noise_profile_save')}
          </Button>
          <Button
            size="sm"
            variant="outline-secondary"
            className="d-inline-flex align-items-center justify-content-center gap-1"
            disabled={saving || history.length === 0}
            title={t('noise_profile_undo_hint')}
            onClick={undo}
            data-testid="noise-profile-editor-undo"
          >
            <ArrowCounterclockwise size={13} />
            {t('noise_profile_undo')}
          </Button>
          <Button
            size="sm"
            variant="outline-secondary"
            disabled={saving || history.length === 0}
            onClick={undoAll}
            data-testid="noise-profile-editor-undo-all"
          >
            {t('noise_profile_undo_all')}
          </Button>
          <Button
            size="sm"
            variant="outline-danger"
            disabled={saving}
            onClick={onCancel}
            data-testid="noise-profile-editor-cancel"
          >
            {t('noise_profile_cancel')}
          </Button>
        </div>
      </div>
      <div className="small text-muted mt-2" data-testid="noise-profile-editor-hint">
        {t('noise_profile_draft_hint')}
      </div>
    </div>
  );
};

export default NoiseProfileEditor;
