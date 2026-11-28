import type { Dispatch, SetStateAction } from 'react';
import {
  CheckLg,
  ChevronLeft,
  ChevronRight,
  PencilSquare,
  PlusLg,
  Save,
} from 'react-bootstrap-icons';
import { useAuth } from '../../hooks/CoreAuthProvider';
import CadUploadDropbox from '../components/form/CadUploadDropbox.tsx';
import RedDropbox from '../components/form/RedDropbox.tsx';
import DeleteIconButton from '../components/ui/kit/DeleteIconButton';
import PillButton from '../components/ui/kit/PillButton';
import LocationPicker from '../components/location/LocationPicker';
import { repeatedTestId } from '../testIds';
import { formatDate } from './dateFormat';
import {
  Chip,
  LageplanThumb,
  Notice,
  StepCard,
} from './LageplanWizardComponents';
import type {
  DeviceRange,
  MeasurePoint,
  WizardDevice,
  WizardLageplan,
  WizardLocation,
} from './lageplanWizardUtils';
import { isAligned, planLabel } from './lageplanWizardUtils';

type LageplanLocationStepProps = {
  locations: WizardLocation[];
  selectedLocationId: number | null;
  selectedLocation: WizardLocation | null;
  loading: boolean;
  onChange: (location: WizardLocation | null) => void;
};

export const LageplanLocationStep = ({
  locations,
  selectedLocationId,
  selectedLocation,
  loading,
  onChange,
}: LageplanLocationStepProps) => (
  <StepCard
    number={1}
    step="location"
    title="Location"
    done={!!selectedLocation}
  >
    <div className="lageplan-picker">
      <LocationPicker
        id="lageplan-location-picker"
        locations={locations}
        value={selectedLocationId}
        valueKey="project_id"
        onChange={onChange}
        loading={loading}
        testId="lageplan-wizard-location"
      />
    </div>

    {!locations.length && !loading && (
      <div className="lageplan-spaced">
        <Notice tone="warning" testId="lageplan-wizard-no-locations">
          No locations are available yet.
        </Notice>
      </div>
    )}
  </StepCard>
);

type LageplanPlansStepProps = {
  locationId: number | null;
  hasImage: boolean;
  plans: WizardLageplan[];
  selectedPlan: WizardLageplan | null;
  selectedPlanId: number | null;
  isProcessing: boolean;
  addingPlan: boolean;
  onAddingPlanChange: (adding: boolean) => void;
  onSelectPlan: (planId: number) => void;
  onMovePlan: (index: number, delta: -1 | 1) => void;
  pointsOnPlan: (planId: number) => number;
  onRenamePlan: (plan: WizardLageplan) => void;
  onRemovePlan: (plan: WizardLageplan) => void;
  onSourceUpload: (response: Record<string, unknown>) => void;
};

type PlanTileProps = {
  plan: WizardLageplan;
  index: number;
  planCount: number;
  selected: boolean;
  isProcessing: boolean;
  pointCount: number;
  onSelect: () => void;
  onMove: (delta: -1 | 1) => void;
  onRename: () => void;
  onRemove: () => void;
};

const PlanTile = ({
  plan,
  index,
  planCount,
  selected,
  isProcessing,
  pointCount,
  onSelect,
  onMove,
  onRename,
  onRemove,
}: PlanTileProps) => {
  const updated = plan.last_updated ? new Date(plan.last_updated) : null;

  return (
    <div
      className="lageplan-tile-wrap"
      {...repeatedTestId('lageplan-tile', plan.id)}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="lageplan-tile"
        {...repeatedTestId('lageplan-tile-select', plan.id)}
      >
        <LageplanThumb key={plan.url ?? ''} url={plan.url} />
        {selected && (
          <span className="lageplan-tile-check">
            <CheckLg size={13} />
          </span>
        )}
        <div className="lageplan-tile-text">
          <div title={planLabel(plan)} className="lageplan-tile-name">
            {planLabel(plan)}
          </div>
          <div className="lageplan-tile-meta">
            #{plan.id}
            {updated && !Number.isNaN(updated.getTime())
              ? ` · ${formatDate(updated, 'date')}`
              : ''}
            {` · ${pointCount} point(s)`}
          </div>
          <div className="lageplan-tile-chips">
            {index === 0 && planCount > 1 && (
              <span title="The first plan - measure points without a plan show on it">
                <Chip variant="main">Main plan</Chip>
              </span>
            )}
            {plan.is_active ? (
              <Chip variant="active">Active</Chip>
            ) : (
              <Chip>Inactive</Chip>
            )}
            {isAligned(plan) && <Chip>Aligned</Chip>}
            {plan.meters_per_pixel ? <Chip>Scale set</Chip> : null}
          </div>
        </div>
      </button>
      {planCount > 1 && (
        <span className="lageplan-tile-order">
          <button
            type="button"
            title="Move earlier"
            aria-label={`Move “${planLabel(plan)}” earlier`}
            disabled={isProcessing || index === 0}
            onClick={() => onMove(-1)}
            {...repeatedTestId('lageplan-tile-move-earlier', plan.id)}
            className="progeo-icon-button progeo-icon-button--small"
          >
            <ChevronLeft size={13} />
          </button>
          <span
            title={`Place ${index + 1} of ${planCount}`}
            className="lageplan-tile-place"
            {...repeatedTestId('lageplan-tile-place', plan.id)}
          >
            {index + 1}
          </span>
          <button
            type="button"
            title="Move later"
            aria-label={`Move “${planLabel(plan)}” later`}
            disabled={isProcessing || index === planCount - 1}
            onClick={() => onMove(1)}
            {...repeatedTestId('lageplan-tile-move-later', plan.id)}
            className="progeo-icon-button progeo-icon-button--small"
          >
            <ChevronRight size={13} />
          </button>
        </span>
      )}
      <span className="lageplan-tile-actions">
        <button
          type="button"
          title="Rename Lageplan"
          aria-label="Rename Lageplan"
          disabled={isProcessing}
          onClick={onRename}
          {...repeatedTestId('lageplan-tile-rename', plan.id)}
          className="progeo-icon-button"
        >
          <PencilSquare size={14} />
        </button>
        <DeleteIconButton
          label="Remove Lageplan"
          disabled={isProcessing}
          onClick={onRemove}
          testId="lageplan-tile-remove"
          testKey={plan.id}
        />
      </span>
    </div>
  );
};

const PlanUpload = ({
  locationId,
  planCount,
  onCancel,
  onSourceUpload,
}: {
  locationId: number;
  planCount: number;
  onCancel: () => void;
  onSourceUpload: (response: Record<string, unknown>) => void;
}) => {
  const auth = useAuth();

  return (
    <div className="lageplan-upload" data-testid="lageplan-wizard-plan-upload">
      <div className="d-flex align-items-start gap-2">
        <div>
          <div className="lageplan-upload-title">Add a Lageplan</div>
          <div className="lageplan-muted lageplan-muted--small">
            Upload a PNG rendering of the plan - it is added to the existing
            ones and selected. A PDF export of the CAD plan is rendered as PNG,
            cropped to the plan. For a smartex dm location its &quot;dm NNN&quot;
            bands become the measure points (start at the label, end, number).
          </div>
        </div>
        {planCount > 0 && (
          <div className="ms-auto">
            <PillButton
              variant="ghost"
              label="Cancel"
              onClick={onCancel}
              testId="lageplan-wizard-plan-upload-cancel"
            />
          </div>
        )}
      </div>
      <div className="lageplan-upload-drops">
        <RedDropbox
          auth={auth}
          url="/v1/status/measure_points/upload_png/"
          accept="image"
          testId="lageplan-wizard-plan-upload-png"
          hint="Drop a PNG here, or click to choose"
          instantFileUpload={true}
          withPreview={false}
          payload={{ location_id: locationId }}
          callBackProcessing={onSourceUpload}
        />
        <CadUploadDropbox
          auth={auth}
          url="/v1/status/measure_points/from_pdf/"
          accept="pdf"
          testId="lageplan-wizard-plan-upload-pdf"
          maxSizeMB={50}
          hint="Drop one or more PDFs here (a Lageplan each), or click to choose"
          instantFileUpload={true}
          withPreview={false}
          payload={{ location_id: locationId }}
          callBackProcessing={onSourceUpload}
        />
      </div>
    </div>
  );
};

export const LageplanPlansStep = ({
  locationId,
  hasImage,
  plans,
  selectedPlan,
  selectedPlanId,
  isProcessing,
  addingPlan,
  onAddingPlanChange,
  onSelectPlan,
  onMovePlan,
  pointsOnPlan,
  onRenamePlan,
  onRemovePlan,
  onSourceUpload,
}: LageplanPlansStepProps) => (
  <StepCard
    number={3}
    step="plans"
    title="Lageplan"
    done={hasImage}
    actions={
      plans.length > 0 && (
        <span
          className="lageplan-muted"
          data-testid="lageplan-wizard-plan-count"
        >
          {plans.length} plan(s) for this location
        </span>
      )
    }
  >
    {locationId === null ? (
      <Notice tone="warning" testId="lageplan-wizard-plans-need-location">
        Select a location in step 1 first.
      </Notice>
    ) : (
      <div className="d-flex flex-column gap-3">
        {plans.length === 0 && !isProcessing && (
          <Notice testId="lageplan-wizard-no-plans">
            This location has no Lageplan yet - upload the first one below.
          </Notice>
        )}
        {plans.length > 0 && (
          <div className="lageplan-tiles" data-testid="lageplan-wizard-plans">
            {plans.map((plan, index) => (
              <PlanTile
                key={plan.id}
                plan={plan}
                index={index}
                planCount={plans.length}
                selected={plan.id === selectedPlanId}
                isProcessing={isProcessing}
                pointCount={pointsOnPlan(plan.id)}
                onSelect={() => onSelectPlan(plan.id)}
                onMove={(delta) => onMovePlan(index, delta)}
                onRename={() => onRenamePlan(plan)}
                onRemove={() => onRemovePlan(plan)}
              />
            ))}
            {!addingPlan && (
              <button
                type="button"
                onClick={() => onAddingPlanChange(true)}
                className="lageplan-tile lageplan-tile--add"
                data-testid="lageplan-wizard-add-plan"
              >
                <span className="lageplan-tile-add-icon">
                  <PlusLg size={15} />
                </span>
                Add Lageplan
              </button>
            )}
          </div>
        )}
        {(addingPlan || plans.length === 0) && (
          <PlanUpload
            locationId={locationId}
            planCount={plans.length}
            onCancel={() => onAddingPlanChange(false)}
            onSourceUpload={onSourceUpload}
          />
        )}
        {selectedPlan && !selectedPlan.url && (
          <Notice tone="warning" testId="lageplan-wizard-plan-no-file">
            The selected Lageplan has no file - pick another one or upload a new
            plan.
          </Notice>
        )}
      </div>
    )}
  </StepCard>
);

type LageplanDeviceStepProps = {
  locationId: number | null;
  devices: WizardDevice[];
  measurePoints: MeasurePoint[];
  deviceRanges: DeviceRange[];
  onDeviceRangesChange: Dispatch<SetStateAction<DeviceRange[]>>;
  deviceRangesProblem: string | null;
  isProcessing?: boolean;
  /** Saves the ranges on their own (first sensors, points' devices) - without an import. */
  onSave?: () => void;
};

export const LageplanDeviceStep = ({
  locationId,
  devices,
  measurePoints,
  deviceRanges,
  onDeviceRangesChange,
  deviceRangesProblem,
  isProcessing = false,
  onSave,
}: LageplanDeviceStepProps) => {
  const usedRanges = deviceRanges.filter((range) => range.deviceId != null);
  const connectedCount = (deviceId: number) =>
    measurePoints.filter((point) => Number(point.device) === deviceId).length;

  return (
    <StepCard
      number={2}
      step="devices"
      title="Device"
      done={usedRanges.length > 0 && !deviceRangesProblem}
      actions={
        locationId !== null && (
          <>
            <span
              className="lageplan-muted"
              data-testid="lageplan-wizard-device-count"
            >
              {devices.length} device(s) at this location
            </span>
            {onSave && devices.length > 0 && (
              <PillButton
                icon={<Save size={13} />}
                label="Save ranges"
                title="Save the devices' first sensors and connect their points - without importing"
                onClick={onSave}
                disabled={
                  isProcessing || usedRanges.length === 0 || Boolean(deviceRangesProblem)
                }
                testId="lageplan-wizard-device-ranges-save"
              />
            )}
          </>
        )
      }
    >
      {locationId === null ? (
        <Notice tone="warning" testId="lageplan-wizard-devices-need-location">
          Select a location in step 1 first.
        </Notice>
      ) : (
        <div
          className="d-flex flex-column gap-2"
          data-testid="lageplan-wizard-device-ranges"
        >
          <div className="lageplan-muted lageplan-muted--small">
            {devices.length === 0
              ? 'No devices are connected to this location - the points are imported without device.'
              : 'The sensors imported in step 4 (CAD/JSON/TXT) are connected to these devices. Each device counts its pairs from 1: pair 1 is the first sensor of its range. Leave "to" empty for all sensors from "from" on. Placing sensors manually picks the device per sensor in step 4.'}
          </div>
          {deviceRanges.map((range, index) => (
            <div
              key={index}
              className="d-flex flex-wrap align-items-center gap-2"
              {...repeatedTestId('lageplan-wizard-device-range', index)}
            >
              <select
                aria-label="Device"
                className="form-select form-select-sm lageplan-range-field lageplan-range-field--device"
                value={range.deviceId ?? ''}
                {...repeatedTestId(
                  'lageplan-wizard-device-range-device',
                  index,
                )}
                onChange={(event) => {
                  const value = event.target.value;
                  onDeviceRangesChange((current) =>
                    current.map((item, position) =>
                      position === index
                        ? {
                            ...item,
                            deviceId: value ? Number(value) : null,
                          }
                        : item,
                    ),
                  );
                }}
              >
                <option value="">choose a device</option>
                {devices.map((device) => {
                  const connected = connectedCount(device.id);
                  return (
                    <option key={device.id} value={device.id}>
                      {device.raw_hash}
                      {device.hardware ? ` · ${device.hardware}` : ''}
                      {connected ? ` · ${connected} point(s) now` : ''}
                    </option>
                  );
                })}
              </select>
              <span className="lageplan-muted lageplan-muted--small">
                sensors
              </span>
              <input
                aria-label="First sensor"
                type="number"
                min={1}
                className="form-control form-control-sm lageplan-range-field lageplan-range-field--number"
                placeholder="1"
                value={range.from}
                onChange={(event) => {
                  const value = event.target.value;
                  onDeviceRangesChange((current) =>
                    current.map((item, position) =>
                      position === index ? { ...item, from: value } : item,
                    ),
                  );
                }}
                {...repeatedTestId('lageplan-wizard-device-range-from', index)}
              />
              <span className="lageplan-muted lageplan-muted--small">to</span>
              <input
                aria-label="Last sensor"
                type="number"
                min={1}
                className="form-control form-control-sm lageplan-range-field lageplan-range-field--number"
                placeholder="last"
                value={range.to}
                onChange={(event) => {
                  const value = event.target.value;
                  onDeviceRangesChange((current) =>
                    current.map((item, position) =>
                      position === index ? { ...item, to: value } : item,
                    ),
                  );
                }}
                {...repeatedTestId('lageplan-wizard-device-range-to', index)}
              />
              <DeleteIconButton
                label="Remove this device"
                onClick={() =>
                  onDeviceRangesChange((current) =>
                    current.filter((_item, position) => position !== index),
                  )
                }
                testId="lageplan-wizard-device-range-remove"
                testKey={index}
              />
            </div>
          ))}
          {devices.length > deviceRanges.length && (
            <div>
              <PillButton
                variant="ghost"
                label={
                  deviceRanges.length
                    ? 'Add another device'
                    : 'Connect a device'
                }
                testId="lageplan-wizard-device-range-add"
                onClick={() =>
                  onDeviceRangesChange((current) => {
                    const last = current[current.length - 1];
                    const next = last?.to.trim()
                      ? String(Number(last.to) + 1)
                      : current.length
                        ? ''
                        : '1';
                    const unused = devices.find(
                      (device) =>
                        !current.some((range) => range.deviceId === device.id),
                    );
                    return [
                      ...current,
                      { deviceId: unused?.id ?? null, from: next, to: '' },
                    ];
                  })
                }
              />
            </div>
          )}
          {deviceRangesProblem && (
            <Notice
              tone="warning"
              testId="lageplan-wizard-device-ranges-problem"
            >
              {deviceRangesProblem}
            </Notice>
          )}
        </div>
      )}
    </StepCard>
  );
};
