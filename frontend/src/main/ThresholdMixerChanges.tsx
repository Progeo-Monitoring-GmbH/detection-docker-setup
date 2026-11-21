import type { Dispatch, SetStateAction } from 'react';
import { ArrowCounterclockwise, XLg } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import PillButton from '../components/ui/kit/PillButton';
import { childTestId, repeatedTestId } from '../testIds';
import { type MixerSensor, NO_DRAFTS, type ThresholdChange, type ThresholdDrafts, withoutChange } from './thresholdMixer';
import { changeTextOf, sensorLabelOf } from './thresholdMixerView';

/** The pending changes, each undoable, next to "Speichern" and "Verwerfen". */
const ThresholdMixerChanges = ({
  testId,
  sensors,
  changes,
  drafts,
  setDrafts,
  objectThreshold,
  saving,
  onSave,
}: {
  testId: string;
  sensors: MixerSensor[];
  changes: ThresholdChange[];
  drafts: ThresholdDrafts;
  setDrafts: Dispatch<SetStateAction<ThresholdDrafts>>;
  objectThreshold: number | null;
  saving: boolean;
  onSave: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <div className="d-flex gap-3 flex-wrap align-items-stretch">
      <div data-testid="threshold-changes" className="threshold-mixer-changes">
        <div className="threshold-mixer-changes-title">{t('einstell_mixer_changes', { count: changes.length })}</div>
        {changes.length === 0 ? (
          <div className="threshold-mixer-changes-empty" data-testid={childTestId(testId, 'changes-empty')}>{t('einstell_mixer_no_changes')}</div>
        ) : (
          changes.map((change) => (
            <div
              key={change.key}
              className="d-flex align-items-center gap-2 threshold-mixer-change"
              {...repeatedTestId(`${testId}-change`, change.key)}
            >
              <span className="threshold-mixer-change-label">
                {change.kind === 'object' ? t('einstell_mixer_object') : sensorLabelOf(sensors, change.sensorOrder, t)}
              </span>
              <span className="threshold-mixer-change-value">{changeTextOf(change, objectThreshold, t)}</span>
              <button
                type="button"
                title={t('einstell_mixer_undo')}
                aria-label={t('einstell_mixer_undo')}
                onClick={() => setDrafts((prev) => withoutChange(prev, change))}
                className="threshold-mixer-undo"
                {...repeatedTestId(`${testId}-change-undo`, change.key)}
              >
                <XLg size={11} />
              </button>
            </div>
          ))
        )}
      </div>
      <div className="threshold-mixer-actions">
        <PillButton
          variant="accent"
          label={saving ? t('einstell_mixer_saving') : t('einstell_mixer_save', { count: changes.length })}
          disabled={saving || changes.length === 0}
          onClick={onSave}
          testId={childTestId(testId, 'save')}
        />
        <PillButton
          variant="ghost"
          icon={<ArrowCounterclockwise size={13} />}
          label={t('einstell_mixer_discard')}
          disabled={saving || (changes.length === 0 && drafts === NO_DRAFTS)}
          onClick={() => setDrafts(NO_DRAFTS)}
          testId={childTestId(testId, 'discard')}
        />
      </div>
    </div>
  );
};

export default ThresholdMixerChanges;
