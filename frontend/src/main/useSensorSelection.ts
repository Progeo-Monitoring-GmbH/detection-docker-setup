import { useMemo, useState } from 'react';
import {
  addedSensor,
  focusedPositionOf,
  type SensorFocus,
} from './analyseFocus';
import {
  planAreaPick,
  planSensorPick,
  type SelectionPoint,
  selectedPositionsOf,
  withSensor,
} from './analyseSelection';

/**
 * The sensors (pair index) the measurements' second plot follows - picked
 * there or on the heatmap - and the one of them picked last (the focus: a
 * white ring on the plan, the others lila). A pick on the plan of another
 * device's sensor shows that device (`onDevice`).
 */
const useSensorSelection = ({
  points,
  shownDevice,
  deviceIds,
  onDevice,
}: {
  points: readonly SelectionPoint[];
  shownDevice: number | null;
  deviceIds: readonly number[];
  onDevice: (device: number) => void;
}) => {
  const [sensors, setSensors] = useState<number[]>([]);
  const [sensorFocus, setSensorFocus] = useState<SensorFocus | null>(null);

  // The plan's sensors (pos) of the selection: the pairs of the shown device.
  const selectedPositions = useMemo(
    () => selectedPositionsOf(points, sensors, shownDevice),
    [points, sensors, shownDevice],
  );
  const focusedPosition = focusedPositionOf(
    points,
    sensorFocus,
    sensors,
    shownDevice,
  );

  // A selection change from the charts: a single added sensor gets the focus.
  const changeSensors = (next: number[]) => {
    const added = addedSensor(sensors, next);
    if (added != null) {
      setSensorFocus({ device: shownDevice, pair: added });
    }
    setSensors(next);
  };

  // An area dragged on the plan: its sensors (of the shown device, else of
  // the first other one - shown then) become the selection.
  const selectPlanArea = (positions: number[]) => {
    const pick = planAreaPick(points, positions, shownDevice, deviceIds);
    if (!pick) {
      return;
    }
    if (pick.device != null) {
      onDevice(pick.device);
    }
    setSensors(pick.pairs);
  };

  // A sensor clicked on the plan is added to the selection (another
  // device's: it alone, that device shown) - and focused, also when active.
  const selectPlanSensor = (pos: number) => {
    const { device, pair } = planSensorPick(
      points,
      pos,
      shownDevice,
      deviceIds,
    );
    if (device != null) {
      onDevice(device);
      setSensors([pair]);
      setSensorFocus({ device, pair });
      return;
    }
    setSensorFocus({ device: shownDevice, pair });
    setSensors((selected) => withSensor(selected, pair));
  };

  return {
    sensors,
    selectedPositions,
    focusedPosition,
    changeSensors,
    selectPlanArea,
    selectPlanSensor,
  };
};

export default useSensorSelection;
