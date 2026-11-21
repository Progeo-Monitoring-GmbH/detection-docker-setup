import type { Dispatch, SetStateAction } from 'react';
import { SlashCircle } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import PillButton from '../components/ui/kit/PillButton';
import { childTestId } from '../testIds';
import { type MixerSensor, type ThresholdDrafts, withDisabled, withOverrides } from './thresholdMixer';
import { bulkNumberOf, type MixerState, overOrdersOf, selectionFlagsOf } from './thresholdMixerView';

/**
 * The selection tools: select all / the ones over their threshold / none,
 * set the selection to a typed value, remove its own thresholds, switch it
 * off or on again. `orders`: the plot's columns, in plot order.
 */
const ThresholdMixerBulkBar = ({
  testId,
  sensors,
  orders,
  state,
  overCount,
  setSelected,
  setDrafts,
  bulkValue,
  setBulkValue,
}: {
  testId: string;
  sensors: MixerSensor[];
  orders: number[];
  state: MixerState;
  overCount: number;
  setSelected: (selected: Set<number>) => void;
  setDrafts: Dispatch<SetStateAction<ThresholdDrafts>>;
  bulkValue: string;
  setBulkValue: (value: string) => void;
}) => {
  const { t } = useTranslation();
  const { selected, drafts, savedObject } = state;
  const selectedOrders = orders.filter((order) => selected.has(order));
  const bulkNumber = bulkNumberOf(bulkValue);
  const can = selectionFlagsOf(sensors, selected, drafts);
  return (
    <div className="d-flex align-items-center gap-2 flex-wrap threshold-mixer-bulk" data-testid={childTestId(testId, 'bulk')}>
      <span className="threshold-mixer-strong" data-testid={childTestId(testId, 'selected-count')}>{t('einstell_mixer_selected', { count: selectedOrders.length })}</span>
      <PillButton
        variant="ghost"
        label={t('einstell_mixer_select_all')}
        onClick={() => setSelected(new Set(orders))}
        testId={childTestId(testId, 'select-all')}
      />
      <PillButton
        variant="ghost"
        label={t('einstell_mixer_select_over')}
        disabled={overCount === 0}
        onClick={() => setSelected(new Set(overOrdersOf(sensors, savedObject, drafts)))}
        testId={childTestId(testId, 'select-over')}
      />
      <PillButton
        variant="ghost"
        label={t('einstell_mixer_select_none')}
        disabled={selectedOrders.length === 0}
        onClick={() => setSelected(new Set())}
        testId={childTestId(testId, 'select-none')}
      />
      <span className="threshold-mixer-spacer" />
      <input
        type="number"
        min={0}
        placeholder={t('einstell_points_threshold')}
        aria-label={t('einstell_mixer_bulk_value')}
        value={bulkValue}
        onChange={(event) => setBulkValue(event.target.value)}
        className="threshold-mixer-bulk-input"
        data-testid={childTestId(testId, 'bulk-value')}
      />
      <PillButton
        label={t('einstell_mixer_set_selected')}
        disabled={bulkNumber == null || selectedOrders.length === 0}
        onClick={() => bulkNumber != null && setDrafts((prev) => withOverrides(prev, selectedOrders, bulkNumber))}
        testId={childTestId(testId, 'set-selected')}
      />
      <PillButton
        variant="ghost"
        label={t('einstell_mixer_remove_selected')}
        disabled={selectedOrders.length === 0 || !can.anyOwn}
        onClick={() => setDrafts((prev) => withOverrides(prev, selectedOrders, null))}
        testId={childTestId(testId, 'remove-selected')}
      />
      <PillButton
        variant="ghost"
        icon={<SlashCircle size={13} />}
        label={t('einstell_mixer_disable_selected')}
        title={t('einstell_mixer_disabled_hint')}
        disabled={!can.anyEnabled}
        onClick={() => setDrafts((prev) => withDisabled(prev, selectedOrders, true))}
        testId={childTestId(testId, 'disable-selected')}
      />
      <PillButton
        variant="ghost"
        label={t('einstell_mixer_enable_selected')}
        disabled={!can.anyDisabled}
        onClick={() => setDrafts((prev) => withDisabled(prev, selectedOrders, false))}
        testId={childTestId(testId, 'enable-selected')}
      />
    </div>
  );
};

export default ThresholdMixerBulkBar;
