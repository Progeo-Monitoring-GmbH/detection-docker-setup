import { useAuth } from '../../hooks/CoreAuthProvider';
import usePermissions from '../../hooks/usePermissions';
import { staffFlags } from './access';
import { planVisualization } from './projectType';
import '../components/ui/kit/kit.css';
import './LageplanWizard.css';
import {
  Notice,
  TargetStepContext,
  LageplanWizardDialogs,
  LageplanWizardHead,
} from './LageplanWizardComponents';
import {
  LageplanDeviceStep,
  LageplanLocationStep,
  LageplanPlansStep,
} from './LageplanWizardSetupSteps';
import {
  LageplanManualSensorPlacement,
  LageplanPointsStep,
} from './LageplanWizardPointSteps';
import {
  LageplanAlignStep,
  LageplanDmTransferStep,
  LageplanHeatLimitsStep,
  LageplanKlemmlisteStep,
} from './LageplanWizardPlanSteps';
import {
  useLageplanWizardState,
  useLocationSelection,
  useMeasurePointsLoad,
  useWizardDerived,
  useWizardLocations,
} from './useLageplanWizardState';
import {
  useCanvasEdits,
  usePlanActions,
  usePointActions,
} from './useLageplanWizardActions';
import { useWizardTargetStep } from './useWizardTargetStep';

// -- the wizard ---------------------------------------------------------------
// Its state and loading: useLageplanWizardState.ts; what the steps store:
// useLageplanWizardActions.ts; the steps: LageplanWizard*Steps.tsx.

const LageplanWizardView = () => {
  const auth = useAuth();
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  // Backend: every measure_points endpoint (load + uploads) requires
  // module_devices_edit; storing the alignment (/v1/location/update/)
  // requires module_locations_edit.
  const canEditDevices = hasPermission('module_devices_edit');
  const canEditLocation = hasPermission('module_locations_edit');
  // Step 7 (heat limitations): staff and superusers, like the backend.
  const staff = staffFlags(auth?.user).isStaffOrSuperuser;

  const state = useLageplanWizardState(auth);
  const { selectedLocationId, selectedPlanId, lageplans, measurePoints } =
    state;
  const targetStep = useWizardTargetStep(selectedLocationId);
  const { locations, locationLoading } = useWizardLocations(
    auth,
    state.setError,
  );
  const { selectedLocation, selectLocation } = useLocationSelection(
    locations,
    state,
  );
  useMeasurePointsLoad(state);

  const derived = useWizardDerived(state);
  const { selectedPlan, sourceMeta, planPoints, planSensors } = derived;
  const plans = usePlanActions(state);
  const { onDiscardCut, ...canvasEdits } = useCanvasEdits(
    state,
    derived,
    plans.updatePlan,
  );
  const points = usePointActions(state, derived);
  const hasPlanImage = Boolean(sourceMeta?.imageUrl);

  if (!permissionsLoading && !canEditDevices) {
    return (
      <div data-testid="page-lageplan-wizard">
        <Notice tone="warning" testId="lageplan-wizard-no-permission">
          You do not have permission to edit measure points.
        </Notice>
      </div>
    );
  }

  return (
    <TargetStepContext.Provider value={targetStep}>
      <div className="lageplan-wizard" data-testid="page-lageplan-wizard">
        <LageplanWizardHead
          isProcessing={state.isProcessing}
          onReset={() => selectLocation(null)}
        />

        {state.error && (
          <Notice tone="danger" testId="lageplan-wizard-error">
            {state.error}
          </Notice>
        )}

        <LageplanLocationStep
          locations={locations}
          selectedLocationId={selectedLocationId}
          selectedLocation={selectedLocation}
          loading={locationLoading}
          onChange={selectLocation}
        />
        <LageplanDeviceStep
          locationId={selectedLocationId}
          devices={state.devices}
          measurePoints={measurePoints}
          deviceRanges={state.deviceRanges}
          onDeviceRangesChange={state.setDeviceRanges}
          deviceRangesProblem={derived.deviceRangesProblem}
        />
        <LageplanPlansStep
          locationId={selectedLocationId}
          hasImage={hasPlanImage}
          plans={lageplans}
          selectedPlan={selectedPlan}
          selectedPlanId={selectedPlanId}
          isProcessing={state.isProcessing}
          addingPlan={state.addingPlan}
          onAddingPlanChange={state.setAddingPlan}
          onSelectPlan={plans.selectPlan}
          onMovePlan={plans.movePlan}
          pointsOnPlan={derived.pointsOnPlan}
          onRenamePlan={plans.startRename}
          onRemovePlan={plans.confirmRemove}
          onSourceUpload={plans.handleSourceUpload}
        />
        <LageplanPointsStep
          locationId={selectedLocationId}
          measurePoints={measurePoints}
          placementDirty={state.placementDirty}
          isProcessing={state.isProcessing}
          pointSource={state.pointSource}
          onPointSourceChange={state.setPointSource}
          deviceRangesProblem={derived.deviceRangesProblem}
          importPayload={derived.importPayload}
          onCadUpload={points.handleCadUpload}
          onJsonUpload={points.handleJsonUpload}
          manualSensors={
            <LageplanManualSensorPlacement
              devices={state.devices}
              placedSensors={state.placedSensors}
              selectedPlanId={selectedPlanId}
              activeDeviceId={state.activeDeviceId}
              activeDevice={derived.activeDevice}
              planSensors={planSensors}
              placementDirty={state.placementDirty}
              isProcessing={state.isProcessing}
              replacedPointCount={derived.replacedPointCount}
              hasPlanImage={hasPlanImage}
              planNameOf={derived.planNameOf}
              belongsTo={derived.belongsTo}
              onActiveDeviceChange={state.setActiveDeviceId}
              onRemoveActiveSensor={points.removeActiveSensor}
              onDiscardPlacement={points.discardPlacement}
              onSaveManualSensors={points.handleSaveManualSensors}
            />
          }
          plans={lageplans}
          selectedPlanId={selectedPlanId}
          cadPayload={state.cadPayload}
          planNameOf={derived.planNameOf}
          pointsOnPlan={derived.pointsOnPlan}
          importReplaces={derived.importReplaces}
          onClear={points.confirmClear}
        />
        <LageplanAlignStep
          sourceMeta={sourceMeta}
          locationId={selectedLocationId}
          planId={selectedPlanId}
          lineSensors={
            planVisualization(selectedLocation?.project_type) === 'lines'
          }
          planPoints={planPoints}
          planSensors={planSensors}
          deviceLabels={derived.deviceLabels}
          devicePairStarts={derived.devicePairStarts}
          canEdit={canEditLocation}
          edits={{
            onSaveSliders: plans.handleSaveSliders,
            onSaveScale: plans.handleSaveScale,
            ...canvasEdits,
          }}
          cutPoints={state.cutPoints}
          onDiscardCut={onDiscardCut}
          placement={points.canvasPlacement}
        />
        <LageplanDmTransferStep
          locationId={selectedLocationId}
          planId={selectedPlanId}
          plan={selectedPlan}
          planPoints={planPoints}
          canEdit={canEditDevices}
          onStored={state.reload}
        />
        {staff && (
          <LageplanHeatLimitsStep
            plan={selectedPlan}
            plans={lageplans}
            points={derived.heatPoints}
            editable={staff}
            onChange={plans.setHeatLimitations}
          />
        )}
        <LageplanKlemmlisteStep
          auth={auth}
          locationId={selectedLocationId}
          devices={state.devices}
          staff={staff}
          onNamesApplied={state.reload}
        />

        <LageplanWizardDialogs
          confirmAction={state.confirmAction}
          renaming={state.renaming}
          measurePointCount={measurePoints.length}
          isProcessing={state.isProcessing}
          pointsOnPlan={derived.pointsOnPlan}
          onConfirmActionChange={state.setConfirmAction}
          onDeletePlan={plans.deletePlan}
          onClearMeasurePoints={points.clearMeasurePoints}
          onRenamingChange={state.setRenaming}
          onRenamePlan={plans.renamePlan}
        />
      </div>
    </TargetStepContext.Provider>
  );
};

export default LageplanWizardView;
