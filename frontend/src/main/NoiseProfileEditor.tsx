import { useState } from 'react';
import { Button, Card, Form, Spinner } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { formatDate } from './dateFormat';
import {
  editMask,
  type MaskOperation,
  type MaskTarget,
  type NoiseProfileDraft,
  type NoiseRating,
} from './noiseProfiles';

type NoiseProfileEditorProps = {
  draft: NoiseProfileDraft;
  onChange: (draft: NoiseProfileDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  /** The plots show the draft applied (else the raw values with its masks as lines). */
  preview: boolean;
  onPreviewChange: (preview: boolean) => void;
  rating: NoiseRating | null;
};

const percent = (value: number) => `${Math.round(value * 100)} %`;

/** A mask value typed by hand: a whole number, never below 0. */
const parseMaskValue = (text: string) => {
  const value = Math.round(Number(text.replace(',', '.')));
  return Number.isFinite(value) ? Math.max(0, value) : null;
};

/**
 * Staff: a Störungsprofil being made (from the minimum EP / WP of the
 * period) or edited - name, the masks per sensor by hand or in bulk. Saved
 * only with "Speichern"; meanwhile the plots preview it.
 */
const NoiseProfileEditor = ({
  draft,
  onChange,
  onSave,
  onCancel,
  saving,
  preview,
  onPreviewChange,
  rating,
}: NoiseProfileEditorProps) => {
  const { t } = useTranslation();
  const sensors = Math.max(draft.mask_e.length, draft.mask_w.length);
  const [target, setTarget] = useState<MaskTarget>('both');
  const [operation, setOperation] = useState<MaskOperation>('add');
  const [amount, setAmount] = useState('0');
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState(String(Math.max(1, sensors)));

  const sumE = draft.mask_e.reduce((sum, value) => sum + value, 0);
  const sumW = draft.mask_w.reduce((sum, value) => sum + value, 0);

  const setValue = (mask: 'mask_e' | 'mask_w', index: number, text: string) => {
    const value = parseMaskValue(text);
    if (value == null || draft[mask][index] === value) {
      return;
    }
    const next = [...draft[mask]];
    while (next.length <= index) {
      next.push(0);
    }
    next[index] = value;
    onChange({ ...draft, [mask]: next });
  };

  const bulkValue = Number(amount.replace(',', '.'));
  const bulkFrom = Math.max(1, Math.round(Number(from)) || 1);
  const bulkTo = Math.max(bulkFrom, Math.round(Number(to)) || sensors);
  const applyBulk = () => {
    if (!Number.isFinite(bulkValue)) {
      return;
    }
    onChange({ ...draft, ...editMask(draft, target, operation, bulkValue, bulkFrom, bulkTo) });
  };

  return (
    <Card className="border mb-3" data-testid="noise-profile-editor">
      <Card.Body className="py-2">
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
          {rating && (
            <div className="small" title={t('noise_profile_rating_hint')}>
              {t('noise_profile_rating', {
                name: draft.name,
                score: rating.score,
                fit: percent(rating.fit),
                effect: percent(rating.effect),
                before: rating.exceedBefore,
                after: rating.exceedAfter,
              })}
            </div>
          )}
        </div>

        {/* Bulk change: + / × / = a value on EP and/or WP of sensors from-to. */}
        <div className="d-flex flex-wrap align-items-center gap-2 mb-2 small">
          <span className="text-muted">{t('noise_profile_bulk')}</span>
          <Form.Select
            size="sm"
            style={{ width: 'auto' }}
            aria-label={t('noise_profile_bulk_target')}
            value={target}
            onChange={(event) => setTarget(event.target.value as MaskTarget)}
          >
            <option value="both">EP + WP</option>
            <option value="ep">EP</option>
            <option value="wp">WP</option>
          </Form.Select>
          <Form.Select
            size="sm"
            style={{ width: 'auto' }}
            aria-label={t('noise_profile_bulk_operation')}
            value={operation}
            onChange={(event) => setOperation(event.target.value as MaskOperation)}
          >
            <option value="add">{t('noise_profile_bulk_add')}</option>
            <option value="multiply">{t('noise_profile_bulk_multiply')}</option>
            <option value="set">{t('noise_profile_bulk_set')}</option>
          </Form.Select>
          <Form.Control
            size="sm"
            style={{ width: 90 }}
            inputMode="decimal"
            aria-label={t('noise_profile_bulk_value')}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <span className="text-muted">{t('noise_profile_bulk_sensors')}</span>
          <Form.Control
            size="sm"
            style={{ width: 70 }}
            inputMode="numeric"
            aria-label={t('noise_profile_bulk_from')}
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
          –
          <Form.Control
            size="sm"
            style={{ width: 70 }}
            inputMode="numeric"
            aria-label={t('noise_profile_bulk_to')}
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
          <Button
            size="sm"
            variant="outline-primary"
            className="py-0"
            disabled={!Number.isFinite(bulkValue) || !sensors}
            onClick={applyBulk}
          >
            {t('noise_profile_bulk_apply')}
          </Button>
        </div>

        {/* Every sensor's mask by hand - committed when leaving the field. */}
        <div style={{ maxHeight: 240, overflowY: 'auto' }} className="border rounded mb-2">
          <table className="table table-sm mb-0 small" style={{ tableLayout: 'fixed' }}>
            <thead className="sticky-top bg-white">
              <tr>
                <th style={{ width: 80 }}>{t('noise_profile_sensor')}</th>
                <th>{t('noise_profile_mask_ep')}</th>
                <th>{t('noise_profile_mask_wp')}</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: sensors }, (_, index) => (
                <tr key={index}>
                  <td className="text-muted">{index + 1}</td>
                  {(['mask_e', 'mask_w'] as const).map((mask) => (
                    <td key={mask} className="py-0">
                      <Form.Control
                        // Re-created when the value changes elsewhere (bulk change).
                        key={`${mask}:${draft[mask][index] ?? 0}`}
                        size="sm"
                        className="py-0"
                        inputMode="numeric"
                        aria-label={`${t(mask === 'mask_e' ? 'noise_profile_mask_ep' : 'noise_profile_mask_wp')} ${index + 1}`}
                        defaultValue={draft[mask][index] ?? 0}
                        onBlur={(event) => setValue(mask, index, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            setValue(mask, index, (event.target as HTMLInputElement).value);
                          }
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="d-flex flex-wrap align-items-center gap-2">
          <Button size="sm" variant="primary" disabled={saving || !draft.name.trim() || !sensors} onClick={onSave}>
            {saving && <Spinner size="sm" animation="border" className="me-1" />}
            {t('noise_profile_save')}
          </Button>
          <Button size="sm" variant="outline-secondary" disabled={saving} onClick={onCancel}>
            {t('noise_profile_cancel')}
          </Button>
          <small className="text-muted">{t('noise_profile_draft_hint')}</small>
        </div>
      </Card.Body>
    </Card>
  );
};

export default NoiseProfileEditor;
