import { useState, type ReactNode } from 'react';
import { Badge, Button } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import CadUploadDropbox from '../components/form/CadUploadDropbox.tsx';
import RedDropbox from '../components/form/RedDropbox.tsx';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import DeleteIconButton from '../components/ui/kit/DeleteIconButton';
import FloatingActionBar from '../components/ui/kit/FloatingActionBar';
import PillButton from '../components/ui/kit/PillButton';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import { repeatedTestId } from '../testIds';
import { Notice, StepCard } from './LageplanWizardComponents';
import type {
  ImportedCad,
  MeasurePoint,
  PointSource,
  WizardDevice,
  WizardSensor,
  WizardLageplan,
} from './lageplanWizardUtils';
import { POINT_SOURCES } from './lageplanWizardUtils';
import { deviceLabel } from './lageplanWizardUtils';

type LageplanManualSensorPlacementProps = {
  devices: WizardDevice[];
  placedSensors: WizardSensor[];
  selectedPlanId: number | null;
  activeDeviceId: number | null;
  activeDevice: WizardDevice | null;
  planSensors: WizardSensor[];
  placementDirty: boolean;
  isProcessing: boolean;
  replacedPointCount: number;
  hasPlanImage: boolean;
  planNameOf: (planId: number | null) => string;
  belongsTo: (planRef: unknown, planId: number | null) => boolean;
  onActiveDeviceChange: (deviceId: number | null) => void;
  onRemoveActiveSensor: () => void;
  onDiscardPlacement: () => void;
  onSaveManualSensors: () => Promise<void>;
};

export const LageplanManualSensorPlacement = ({
  devices,
  placedSensors,
  selectedPlanId,
  activeDeviceId,
  activeDevice,
  planSensors,
  placementDirty,
  isProcessing,
  replacedPointCount,
  hasPlanImage,
  planNameOf,
  belongsTo,
  onActiveDeviceChange,
  onRemoveActiveSensor,
  onDiscardPlacement,
  onSaveManualSensors,
}: LageplanManualSensorPlacementProps) => {
  const { t } = useTranslation();
  // Saving replaces the points without a sensor - asked first.
  const [confirmSave, setConfirmSave] = useState(false);
  const save = () => {
    if (replacedPointCount > 0) {
      setConfirmSave(true);
    } else {
      void onSaveManualSensors();
    }
  };
  return (
    <div
      className="d-flex flex-column gap-3"
      data-testid="lageplan-wizard-manual-sensors"
    >
      <div className="lageplan-muted">
        Select a sensor, then click its position on the plan in step 5. Placed
        points can be dragged. Nothing is stored until you save.
      </div>

      {devices.length === 0 ? (
        <Notice tone="warning" testId="lageplan-wizard-no-devices">
          No devices are connected to this location.
        </Notice>
      ) : (
        <div className="d-flex flex-wrap gap-2">
          {devices.map((device) => {
            const sensorIndex = placedSensors.findIndex(
              (sensor) => sensor.deviceId === device.id,
            );
            const order = sensorIndex + 1;
            const sensor = sensorIndex >= 0 ? placedSensors[sensorIndex] : null;
            const elsewhere =
              sensor !== null && !belongsTo(sensor.lageplanId, selectedPlanId);
            const active = device.id === activeDeviceId;
            return (
              <Button
                key={device.id}
                size="sm"
                variant={
                  active
                    ? 'primary'
                    : elsewhere
                      ? 'outline-info'
                      : order
                        ? 'outline-success'
                        : 'outline-secondary'
                }
                className="d-inline-flex align-items-center gap-1 lageplan-pill-button"
                title={[
                  device.hardware,
                  device.type,
                  device.raw_hash,
                  elsewhere && sensor
                    ? `placed on ${planNameOf(sensor.lageplanId)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                onClick={() => onActiveDeviceChange(active ? null : device.id)}
                {...repeatedTestId('lageplan-wizard-sensor-device', device.id)}
              >
                {order > 0 && (
                  <Badge
                    pill
                    bg={active ? 'light' : elsewhere ? 'info' : 'success'}
                    text={active ? 'dark' : undefined}
                  >
                    {order}
                  </Badge>
                )}
                <span className="font-monospace">{deviceLabel(device)}</span>
              </Button>
            );
          })}
        </div>
      )}

      <div className="d-flex flex-wrap align-items-center gap-2">
        <span
          className="lageplan-muted"
          data-testid="lageplan-wizard-placed-count"
        >
          {planSensors.length} on this plan · {placedSensors.length} /{' '}
          {devices.length} placed
          {placementDirty && ' · unsaved changes'}
        </span>
        {activeDevice &&
          placedSensors.some(
            (sensor) => sensor.deviceId === activeDevice.id,
          ) && (
            <DeleteIconButton
              label={`Remove ${deviceLabel(activeDevice)} from the plan`}
              onClick={onRemoveActiveSensor}
              testId="lageplan-wizard-sensor-remove"
            />
          )}
      </div>

      {placementDirty && (
        <FloatingActionBar
          message={`${planSensors.length} sensor(s) on this plan - not saved yet`}
          detail={
            replacedPointCount > 0
              ? `Saving replaces the ${replacedPointCount} existing measure point(s) without a sensor.`
              : 'Placed sensors are only stored with "Save manual sensors".'
          }
          tone={replacedPointCount > 0 ? 'warning' : 'primary'}
          actions={[
            {
              label: 'Discard changes',
              variant: 'secondary',
              disabled: isProcessing,
              onClick: onDiscardPlacement,
              testId: 'lageplan-wizard-placement-discard',
            },
            {
              label: 'Save manual sensors',
              busy: isProcessing,
              onClick: save,
              testId: 'lageplan-wizard-placement-save',
            },
          ]}
          testId="lageplan-wizard-placement-actions"
        />
      )}

      {placementDirty && replacedPointCount > 0 && (
        <Notice tone="warning" testId="lageplan-wizard-placement-replaces">
          Saving replaces the {replacedPointCount} existing measure point(s)
          without a sensor (e.g. from a CAD import).
        </Notice>
      )}
      {!hasPlanImage && (
        <Notice testId="lageplan-wizard-placement-needs-plan">
          Select or add a Lageplan in step 3 to place the sensors.
        </Notice>
      )}
      <ConfirmDialog
        show={confirmSave}
        testId="lageplan-wizard-placement-save-dialog"
        title={t('lageplan_wizard_save_title')}
        message={t('lageplan_wizard_save_message', {
          sensors: placedSensors.length,
          count: replacedPointCount,
        })}
        confirmLabel={t('lageplan_wizard_save_button')}
        cancelLabel={t('lageplan_wizard_cancel')}
        confirming={isProcessing}
        onCancel={() => setConfirmSave(false)}
        onConfirm={() => {
          setConfirmSave(false);
          void onSaveManualSensors();
        }}
      />
    </div>
  );
};

type LageplanPointsStepProps = {
  locationId: number | null;
  measurePoints: MeasurePoint[];
  placementDirty: boolean;
  isProcessing: boolean;
  pointSource: PointSource;
  onPointSourceChange: (source: PointSource) => void;
  deviceRangesProblem: string | null;
  importPayload: Record<string, unknown>;
  onCadUpload: (response: Record<string, unknown>) => void;
  onJsonUpload: (response?: Record<string, unknown>) => void;
  manualSensors: ReactNode;
  plans: WizardLageplan[];
  selectedPlanId: number | null;
  cadPayload: ImportedCad | null;
  planNameOf: (planId: number | null) => string;
  pointsOnPlan: (planId: number) => number;
  /** The points an import replaces: those on the picked plan (without one: the main plan). */
  importReplaces: number;
  onClear: () => void;
};

/** An import waiting for the confirmation: the files, and how to send or drop it. */
type PendingImport = { files: string; send: () => void; cancel: () => void };

export const LageplanPointsStep = ({
  locationId,
  measurePoints,
  placementDirty,
  isProcessing,
  pointSource,
  onPointSourceChange,
  deviceRangesProblem,
  importPayload,
  onCadUpload,
  onJsonUpload,
  manualSensors,
  plans,
  selectedPlanId,
  cadPayload,
  planNameOf,
  pointsOnPlan,
  importReplaces,
  onClear,
}: LageplanPointsStepProps) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(
    null,
  );
  // Every import replaces the points on the plan - the dropboxes ask first.
  const confirmUpload = (files: File[], send: () => void, cancel: () => void) =>
    setPendingImport({
      files: files.map((file) => file.name).join(', '),
      send,
      cancel,
    });

  return (
    <StepCard
      number={4}
      step="points"
      title="Measure points"
      done={measurePoints.length > 0 && !placementDirty}
      actions={
        locationId !== null && (
          <span className="d-flex align-items-center gap-2">
            <span
              className="lageplan-muted"
              data-testid="lageplan-wizard-point-count"
            >
              {measurePoints.length} measure point(s) stored
            </span>
            {measurePoints.length > 0 && (
              <PillButton
                variant="ghost"
                label="Clear measure points"
                disabled={isProcessing}
                onClick={onClear}
                testId="lageplan-wizard-points-clear"
              />
            )}
          </span>
        )
      }
    >
      {locationId === null ? (
        <Notice tone="warning" testId="lageplan-wizard-points-need-location">
          Select a location in step 1 first.
        </Notice>
      ) : (
        <div className="d-flex flex-column gap-3">
          <div className="lageplan-sources">
            <div>
              <SegmentedControl
                options={POINT_SOURCES}
                value={pointSource}
                onChange={(value) => onPointSourceChange(value as PointSource)}
                testId="lageplan-wizard-point-source"
              />
            </div>
          </div>

          {pointSource !== 'manual' && deviceRangesProblem && (
            <Notice tone="warning" testId="lageplan-wizard-import-blocked">
              Fix the device ranges in step 2 before importing.
            </Notice>
          )}
          {!deviceRangesProblem && pointSource === 'cad' && (
            <CadUploadDropbox
              auth={auth}
              url="/v1/status/measure_points/upload_cad/"
              accept="cad"
              testId="lageplan-wizard-import-cad"
              confirmUpload={confirmUpload}
              hint="Drop a DWG/DXF file here, or click to choose"
              maxSizeMB={100}
              instantFileUpload={true}
              withPreview={false}
              payload={importPayload}
              callBackProcessing={onCadUpload}
            />
          )}
          {!deviceRangesProblem && pointSource === 'json' && (
            <RedDropbox
              auth={auth}
              url="/v1/status/measure_points/from_json/"
              accept="json"
              testId="lageplan-wizard-import-json"
              confirmUpload={confirmUpload}
              hint="Drop a JSON file here, or click to choose"
              instantFileUpload={true}
              withPreview={false}
              payload={importPayload}
              callBackProcessing={onJsonUpload}
            />
          )}
          {!deviceRangesProblem && pointSource === 'txt' && (
            <CadUploadDropbox
              auth={auth}
              url="/v1/status/measure_points/upload_cad/"
              accept="text"
              testId="lageplan-wizard-import-txt"
              confirmUpload={confirmUpload}
              hint="Drop a TXT file here, or click to choose"
              instantFileUpload={true}
              withPreview={false}
              payload={importPayload}
              callBackProcessing={onCadUpload}
            />
          )}
          {pointSource === 'manual' && manualSensors}

          {pointSource !== 'manual' &&
            plans.length > 1 &&
            selectedPlanId !== null && (
              <Notice testId="lageplan-wizard-import-target">
                Imported points go onto “{planNameOf(selectedPlanId)}” and
                replace the {pointsOnPlan(selectedPlanId)} point(s) on it - the
                points on the other plans stay.
              </Notice>
            )}
          {cadPayload && pointSource !== 'manual' && (
            <Notice tone="success" testId="lageplan-wizard-import-done">
              Import complete: {cadPayload.stored} points stored
              {cadPayload.lageplan_id != null
                ? ` on “${planNameOf(cadPayload.lageplan_id)}”`
                : ''}
              .
            </Notice>
          )}
          {cadPayload?.warning && pointSource !== 'manual' && (
            <Notice tone="warning" testId="lageplan-wizard-import-warning">
              {cadPayload.warning}
            </Notice>
          )}
        </div>
      )}
      <ConfirmDialog
        show={pendingImport !== null}
        testId="lageplan-wizard-import-dialog"
        title={t('lageplan_wizard_import_title')}
        message={t(
          importReplaces > 0
            ? 'lageplan_wizard_import_message'
            : 'lageplan_wizard_import_message_empty',
          {
            file: pendingImport?.files ?? '',
            plan: planNameOf(selectedPlanId),
            count: importReplaces,
          },
        )}
        confirmLabel={t('lageplan_wizard_import_button')}
        cancelLabel={t('lageplan_wizard_cancel')}
        danger={importReplaces > 0}
        onCancel={() => {
          pendingImport?.cancel();
          setPendingImport(null);
        }}
        onConfirm={() => {
          pendingImport?.send();
          setPendingImport(null);
        }}
      />
    </StepCard>
  );
};
