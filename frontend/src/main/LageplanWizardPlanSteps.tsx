/**
 * Steps 5-8 of the Lageplan wizard (LageplanWizardView.tsx): aligning the
 * points on the picked plan, the dm-Transfer, the heat limitations and the
 * Klemmliste.
 */
import type { ComponentProps } from 'react';
import type { AuthContextType } from '../../hooks/CoreAuthProvider';
import ImageCanvasStage from '../components/ui/ImageCanvasStage.tsx';
import HeatLimitationStage from '../components/device/HeatLimitationStage';
import type { HeatLimitation } from '../components/device/sensorHeatmapTypes';
import DmTransferStep from './DmTransferStep';
import LageplanKlemmliste from './LageplanKlemmliste';
import { Notice, StepCard } from './LageplanWizardComponents';
import {
  deviceLabel,
  type MeasurePoint,
  planLabel,
  type WizardDevice,
  type WizardLageplan,
  type WizardSensor,
} from './lageplanWizardUtils';
import {
  bandCount,
  canvasTitle,
  type PlanSourceMeta,
} from './lageplanWizardLogic';

type CanvasProps = ComponentProps<typeof ImageCanvasStage>;

/** What the canvas may change - offered only to who may edit the location. */
type CanvasEditHandlers = Pick<
  CanvasProps,
  | 'onSaveSliders'
  | 'onSaveScale'
  | 'onImageEdited'
  | 'onPointsRemoved'
  | 'onCut'
  | 'onPointsPlaced'
  | 'onPointsReordered'
>;

type LageplanAlignStepProps = {
  sourceMeta: PlanSourceMeta | null;
  locationId: number | null;
  planId: number | null;
  /** smartex dm: every sensor is a band line (nx/ny -> nx_end/ny_end). */
  lineSensors: boolean;
  planPoints: MeasurePoint[];
  planSensors: WizardSensor[];
  deviceLabels: Record<number, string>;
  devicePairStarts: Record<number, number>;
  canEdit: boolean;
  edits: CanvasEditHandlers;
  cutPoints: MeasurePoint[];
  onDiscardCut: () => void;
  /** Set while the sensors are placed by hand (step 4). */
  placement: CanvasProps['placement'];
};

/** Step 5: the picked plan on the canvas - aligned, scaled and edited there. */
export const LageplanAlignStep = ({
  sourceMeta,
  locationId,
  planId,
  lineSensors,
  planPoints,
  planSensors,
  deviceLabels,
  devicePairStarts,
  canEdit,
  edits,
  cutPoints,
  onDiscardCut,
  placement,
}: LageplanAlignStepProps) => (
  <StepCard number={5} step="align" title="Align and inspect">
    {!sourceMeta?.imageUrl ? (
      <Notice tone="warning" testId="lageplan-wizard-canvas-needs-plan">
        Select or add a Lageplan in step 3 before using the canvas editor.
      </Notice>
    ) : (
      <ImageCanvasStage
        // A different plan starts with its own view (zoom, tools).
        key={planId ?? 'none'}
        testId="lageplan-wizard-canvas"
        sourceMeta={sourceMeta}
        imageUrl={sourceMeta.imageUrl}
        title={canvasTitle({
          manual: placement !== undefined,
          lines: lineSensors,
          sensorCount: planSensors.length,
          pointCount: planPoints.length,
        })}
        fileName={sourceMeta.fileName}
        locationId={locationId ?? undefined}
        lageplanId={planId ?? undefined}
        measurePoints={planPoints}
        lineSensors={lineSensors}
        deviceLabels={deviceLabels}
        devicePairStarts={devicePairStarts}
        withSliders={canEdit}
        {...(canEdit ? edits : {})}
        cutPoints={cutPoints}
        onDiscardCut={onDiscardCut}
        placement={placement}
      />
    )}
  </StepCard>
);

/** Step 6 (optional): the band ends of dm sensors read from the plan. */
export const LageplanDmTransferStep = ({
  locationId,
  planId,
  plan,
  planPoints,
  canEdit,
  onStored,
}: {
  locationId: number | null;
  planId: number | null;
  plan: WizardLageplan | null;
  planPoints: MeasurePoint[];
  canEdit: boolean;
  onStored: () => void;
}) => {
  const planBands = bandCount(planPoints);
  return (
    <StepCard
      number={6}
      step="dmTransfer"
      title="dm-Transfer (optional)"
      done={planPoints.length > 0 && planBands === planPoints.length}
    >
      <DmTransferStep
        // Fresh proposals per location and plan.
        key={`${locationId}-${planId}`}
        locationId={locationId}
        plan={plan ? { id: plan.id, url: plan.url } : null}
        pointCount={planPoints.length}
        pointsWithEnd={planBands}
        canEdit={canEdit}
        onStored={onStored}
      />
    </StepCard>
  );
};

/** Step 7: the areas the heatmap's heat field is limited to (staff). */
export const LageplanHeatLimitsStep = ({
  plan,
  plans,
  points,
  editable,
  onChange,
}: {
  plan: WizardLageplan | null;
  plans: WizardLageplan[];
  /** The points shown on the plan (normalized). */
  points: ComponentProps<typeof HeatLimitationStage>['points'];
  editable: boolean;
  onChange: (planId: number, areas: HeatLimitation[]) => void;
}) => (
  <StepCard
    number={7}
    step="heatLimits"
    title="Heat limitations"
    done={Boolean(plan?.heat_limitations?.length)}
  >
    {!plan?.url ? (
      <Notice tone="warning" testId="lageplan-wizard-heat-limits-need-plan">
        Select or add a Lageplan in step 3 to draw its heat limitations.
      </Notice>
    ) : (
      <>
        <div className="lageplan-muted mb-2">
          The heatmap shows heat only inside these areas of “{planLabel(plan)}”
          - outside them the plan is dimmed here. Without an area the heat is
          not limited.
        </div>
        <HeatLimitationStage
          // A different plan starts with its own view and draft.
          key={plan.id}
          plan={plan}
          plans={plans}
          points={points}
          editable={editable}
          onChange={onChange}
          testId="lageplan-wizard-heat-limits"
        />
      </>
    )}
  </StepCard>
);

/** Step 8: the MEA documents from Airtable and the Klemmliste's sensor names. */
export const LageplanKlemmlisteStep = ({
  auth,
  locationId,
  devices,
  staff,
  onNamesApplied,
}: {
  auth: AuthContextType;
  locationId: number | null;
  devices: WizardDevice[];
  staff: boolean;
  onNamesApplied: () => void;
}) => (
  <StepCard
    number={8}
    step="klemmliste"
    title={staff ? 'MEA documents and Klemmliste' : 'Klemmliste'}
  >
    {locationId === null ? (
      <Notice tone="warning" testId="lageplan-wizard-klemmliste-needs-location">
        Select a location in step 1 first.
      </Notice>
    ) : (
      <LageplanKlemmliste
        // A new location starts the step afresh: its documents, no Klemmliste of the last one.
        key={locationId}
        auth={auth}
        locationId={locationId}
        devices={devices.map((device) => ({
          id: device.id,
          label: deviceLabel(device),
          first_sensor_order: device.first_sensor_order,
        }))}
        staff={staff}
        // The new names show on the plan and in the sensor list.
        onNamesApplied={onNamesApplied}
      />
    )}
  </StepCard>
);
