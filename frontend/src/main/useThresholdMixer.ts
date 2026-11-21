import { useMemo, useState } from 'react';
import { type MixerSensor, NO_DRAFTS, objectThresholdOf, type ThresholdDrafts, thresholdChanges } from './thresholdMixer';
import { liveScaleOf, mixerCountsOf, quietOrdersOf, scrollViewOf, visibleColumnsOf } from './thresholdMixerView';
import useThresholdMixerData from './useThresholdMixerData';
import useThresholdMixerDrag from './useThresholdMixerDrag';
import useThresholdMixerSave from './useThresholdMixerSave';
import useThresholdMixerScroller from './useThresholdMixerScroller';
import useThresholdMixerSelection from './useThresholdMixerSelection';

/**
 * ThresholdMixerPanel's state: the sensors (useThresholdMixerData), the
 * drafts over the saved object threshold, the selection, the columns shown
 * (quiet ones hidden on request), the scroller, the pointer and the save.
 */
const useThresholdMixer = ({
  locationId,
  initialObjectThreshold,
  canEdit,
  onSaved,
  loadedSensors,
}: {
  locationId: number | string;
  initialObjectThreshold: number | null;
  canEdit: boolean;
  onSaved?: () => void;
  loadedSensors: MixerSensor[] | null;
}) => {
  const { sensors, days, loading, pickPeriod, afterSave } = useThresholdMixerData(locationId, loadedSensors);
  const [savedObject, setSavedObject] = useState<number | null>(initialObjectThreshold);
  const [drafts, setDrafts] = useState<ThresholdDrafts>(NO_DRAFTS);
  const selection = useThresholdMixerSelection();
  const state = { drafts, savedObject, selected: selection.selected };
  // Hide the sensors that stay far below their threshold (isQuiet).
  const [hideQuiet, setHideQuiet] = useState(false);

  const quietOrders = useMemo(() => quietOrdersOf(sensors, savedObject), [sensors, savedObject]);
  const columns = visibleColumnsOf(sensors, hideQuiet, quietOrders, state);
  const scroller = useThresholdMixerScroller(columns.length, loading);

  const changes = useMemo(() => thresholdChanges(sensors, savedObject, drafts), [sensors, savedObject, drafts]);
  const liveScale = useMemo(() => liveScaleOf(sensors, savedObject, drafts), [sensors, savedObject, drafts]);
  const pointer = useThresholdMixerDrag({
    canEdit,
    columns,
    column: scroller.column,
    state,
    liveScale,
    setDrafts,
    selection,
    scrollerRef: scroller.scrollerRef,
  });
  const { saving, save } = useThresholdMixerSave({ locationId, changes, setDrafts, setSavedObject, afterSave, onSaved });

  return {
    sensors,
    days,
    loading,
    pickPeriod,
    drafts,
    setDrafts,
    setObject: (value: number | null) => setDrafts((prev) => ({ ...prev, object: value })),
    objectThreshold: objectThresholdOf(savedObject, drafts),
    changes,
    counts: mixerCountsOf(sensors, savedObject, drafts),
    selection,
    state,
    hideQuiet,
    toggleQuiet: () => setHideQuiet((hide) => !hide),
    quietOrders,
    columns,
    orders: columns.map((sensor) => sensor.sensor_order),
    scroller,
    scrollView: scrollViewOf(scroller.scroll, scroller.column, columns.length),
    pointer,
    saving,
    save: () => void save(),
  };
};

export default useThresholdMixer;
