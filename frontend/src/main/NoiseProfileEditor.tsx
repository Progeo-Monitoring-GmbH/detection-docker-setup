import { Button, Form, Spinner } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { formatDate } from './dateFormat';
import { formatSpan, type NoiseProfileDraft } from './noiseProfiles';
import NoiseProfilePlot from './NoiseProfilePlot';

type NoiseProfileEditorProps = {
  draft: NoiseProfileDraft;
  onChange: (draft: NoiseProfileDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  /** The plots show the draft applied (else the raw values with its masks as lines). */
  preview: boolean;
  onPreviewChange: (preview: boolean) => void;
  /** A raw measurement's EP / WP - faint lines in the profile plot. */
  reference?: { ep: number[]; wp: number[] } | null;
};

/**
 * Staff: a Störungsprofil being made (from the minimum EP / WP of the
 * selected period) or edited - its name and its masks as a plot whose values
 * are dragged up and down. Saved only with "Speichern"; meanwhile the
 * measurements preview it.
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
  const sensors = Math.max(draft.mask_e.length, draft.mask_w.length);
  const sumE = draft.mask_e.reduce((sum, value) => sum + value, 0);
  const sumW = draft.mask_w.reduce((sum, value) => sum + value, 0);

  return (
    <div className="border rounded p-2" data-testid="noise-profile-editor">
      <div className="d-flex flex-wrap align-items-end gap-3 mb-2">
        <Form.Group style={{ minWidth: 220 }}>
          <Form.Label className="small mb-1">{t('noise_profile_name')}</Form.Label>
          <Form.Control
            size="sm"
            value={draft.name}
            maxLength={100}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </Form.Group>
        <div className="small text-muted">
          {draft.source_from && (
            <div>
              {t('noise_profile_source', {
                count: draft.source_count,
                from: formatDate(draft.source_from, 'dateTime'),
                to: draft.source_to ? formatDate(draft.source_to, 'dateTime') : t('noise_profile_now'),
              })}
              {draft.source_to &&
                ` (${formatSpan(new Date(draft.source_to).getTime() - new Date(draft.source_from).getTime())})`}
            </div>
          )}
          <div>{t('noise_profile_sums', { sumE, sumW, sensors })}</div>
        </div>
        <Form.Check
          type="switch"
          id="noise-profile-preview"
          className="small"
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
        onChange={(masks) => onChange({ ...draft, ...masks })}
      />

      <div className="d-flex flex-wrap align-items-center gap-2 mt-2">
        <Button size="sm" variant="primary" disabled={saving || !draft.name.trim() || !sensors} onClick={onSave}>
          {saving && <Spinner size="sm" animation="border" className="me-1" />}
          {t('noise_profile_save')}
        </Button>
        <Button size="sm" variant="outline-secondary" disabled={saving} onClick={onCancel}>
          {t('noise_profile_cancel')}
        </Button>
        <small className="text-muted">{t('noise_profile_draft_hint')}</small>
      </div>
    </div>
  );
};

export default NoiseProfileEditor;
