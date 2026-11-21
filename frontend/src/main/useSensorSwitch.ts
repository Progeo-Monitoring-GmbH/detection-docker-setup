import { useMemo, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import {
  showRequestError,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import type { SensorHeatmapPoint } from '../components/device/sensorHeatmapTypes';
import {
  disabledPairsOf,
  overrideKey,
  sensorOrderOf,
} from './analyseSensorSwitch';

type SensorSwitchOptions = {
  locationId: number;
  points: readonly SensorHeatmapPoint[];
  shownDevice: number | null;
  deviceCount: number;
  /** The selected sensors (pair index) of the shown device. */
  sensors: number[];
  /** Switched: the heatmap (plan, thresholds panel) brings the new state. */
  onSwitched: () => void;
};

/**
 * Switching the selected sensors off / on (ProgeoMeasurePoint.disabled -
 * never an alarm, drawn gray). POST measurepoints needs module_locations_edit.
 */
const useSensorSwitch = ({
  locationId,
  points,
  shownDevice,
  deviceCount,
  sensors,
  onSwitched,
}: SensorSwitchOptions) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  // Saved here, before the heatmap brings them: "<location>:<device>:<pair>" -> disabled.
  const [disabledOverrides, setDisabledOverrides] = useState<
    Record<string, boolean>
  >({});
  const [switchingSensors, setSwitchingSensors] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);

  // The shown device's disabled sensors (pair index): drawn gray - what the
  // heatmap says, switched here since then on top.
  const disabledSensors = useMemo(
    () => disabledPairsOf(points, locationId, shownDevice, disabledOverrides),
    [points, shownDevice, locationId, disabledOverrides],
  );
  const selectedEnabled = sensors.filter((pair) => !disabledSensors.has(pair));
  const selectedDisabled = sensors.filter((pair) => disabledSensors.has(pair));

  const switched = (targets: { pair: number }[], disabled: boolean) => {
    setSwitchingSensors(false);
    setDisabledOverrides((overrides) => {
      const next = { ...overrides };
      targets.forEach(({ pair }) => {
        next[overrideKey(locationId, shownDevice, pair)] = disabled;
      });
      return next;
    });
    onSwitched();
    showSuccessBar(
      enqueueSnackbar,
      t(disabled ? 'analyse_sensors_disabled' : 'analyse_sensors_enabled', {
        count: targets.length,
        sensors: targets.map(({ pair }) => pair + 1).join(', '),
      }),
    );
  };

  /** Switch the selected sensors off (`disabled`) or on - the ones not already so. */
  const switchSensors = (disabled: boolean) => {
    const targets = (disabled ? selectedEnabled : selectedDisabled).flatMap(
      (pair) => {
        const order = sensorOrderOf(points, shownDevice, pair, deviceCount);
        return order == null ? [] : [{ pair, order }];
      },
    );
    setConfirmDisable(false);
    if (!targets.length) {
      enqueueSnackbar(t('analyse_sensors_switch_unknown'), {
        variant: 'warning',
      });
      return;
    }
    setSwitchingSensors(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/measurepoints/`,
      {
        points: targets.map(({ order }) => ({ sensor_order: order, disabled })),
      },
      () => switched(targets, disabled),
      (error) => {
        setSwitchingSensors(false);
        showRequestError(
          enqueueSnackbar,
          t('analyse_sensors_switch_failed'),
          error,
        );
      },
    );
  };

  return {
    disabledSensors,
    selectedEnabled,
    selectedDisabled,
    switchingSensors,
    confirmDisable,
    setConfirmDisable,
    switchSensors,
  };
};

export default useSensorSwitch;
