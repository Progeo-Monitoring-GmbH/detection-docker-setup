import { createContext, useContext, useEffect, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { Spinner } from 'react-bootstrap';
import { CheckLg, FileEarmarkPdf } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { getBackendUrl } from '../backendUrl';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import FoldPanel from '../components/ui/kit/FoldPanel';
import PillButton from '../components/ui/kit/PillButton';
import { WIZARD_ANCHORS, type WizardStep } from './lageplanWizardAnchors';
import type {
  WizardConfirmAction,
  WizardLageplan,
} from './lageplanWizardUtils';
import { getFileExt, planLabel } from './lageplanWizardUtils';
import { useLatestRef } from '../components/ui/useLatestRef';

export const TargetStepContext = createContext<string | null>(null);

export const Notice = ({
  tone = 'info',
  children,
  testId,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  children: ReactNode;
  testId?: string;
}) => (
  <div
    className={`lageplan-notice lageplan-notice--${tone}`}
    data-testid={testId}
  >
    {children}
  </div>
);

/** The wizard's title row: what it does, "Processing…", the reset. */
export const LageplanWizardHead = ({
  isProcessing,
  onReset,
}: {
  isProcessing: boolean;
  onReset: () => void;
}) => (
  <div className="lageplan-wizard-head">
    <div>
      <div className="lageplan-wizard-title">Lageplan wizard</div>
      <div className="lageplan-muted">
        Pick a location, choose or add a Lageplan, set the measure points and
        align them on the plan.
      </div>
    </div>
    {isProcessing && (
      <span
        className="d-flex align-items-center gap-2 lageplan-muted"
        data-testid="lageplan-wizard-processing"
      >
        <Spinner animation="border" size="sm" />
        Processing…
      </span>
    )}
    <div className="ms-auto">
      <PillButton
        variant="ghost"
        label="Reset"
        onClick={onReset}
        testId="lageplan-wizard-reset"
      />
    </div>
  </div>
);

export const Chip = ({
  children,
  variant,
}: {
  children: ReactNode;
  variant?: 'main' | 'active';
}) => (
  <span
    className={
      variant ? `lageplan-chip lageplan-chip--${variant}` : 'lageplan-chip'
    }
  >
    {children}
  </span>
);

/** The i18n key of each step's short explanation (shown under its title, folded too). */
const STEP_HINTS: Record<WizardStep, string> = {
  location: 'lageplan_wizard_hint_location',
  devices: 'lageplan_wizard_hint_devices',
  plans: 'lageplan_wizard_hint_plans',
  points: 'lageplan_wizard_hint_points',
  align: 'lageplan_wizard_hint_align',
  autoRepair: 'lageplan_wizard_hint_auto_repair',
  dmTransfer: 'lageplan_wizard_hint_dm_transfer',
  heatLimits: 'lageplan_wizard_hint_heat_limits',
  klemmliste: 'lageplan_wizard_hint_klemmliste',
};

/**
 * One step of the wizard: a FoldPanel, folded by default - unfolded when a
 * link pointed at it (#anchor, TargetStepContext).
 */
export const StepCard = ({
  number,
  step,
  title,
  done,
  actions,
  children,
}: {
  number: number;
  step: WizardStep;
  title: string;
  done?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) => {
  const { t } = useTranslation();
  const targeted = useContext(TargetStepContext) === WIZARD_ANCHORS[step];
  return (
    <FoldPanel
      id={WIZARD_ANCHORS[step]}
      className={targeted ? 'lageplan-step--target' : undefined}
      openOn={targeted}
      title={
        <span className="lageplan-step-title">
          <span
            className={
              done
                ? 'lageplan-step-number lageplan-step-number--done'
                : 'lageplan-step-number'
            }
          >
            {done ? <CheckLg size={13} /> : number}
          </span>
          {title}
        </span>
      }
      hint={t(STEP_HINTS[step])}
      actions={actions}
      testId={`lageplan-wizard-step-${number}`}
    >
      {children}
    </FoldPanel>
  );
};

export const LageplanThumb = ({ url }: { url?: string | null }) => {
  const auth = useAuth();
  const authRef = useLatestRef(auth);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isPdf = getFileExt(url ?? '') === 'pdf';

  useEffect(() => {
    if (!url || isPdf) {
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void axiosConfig.perform_get(
      authRef.current,
      getBackendUrl(url),
      (response) => {
        if (cancelled) {
          return;
        }
        objectUrl = URL.createObjectURL(response.data as Blob);
        setSrc(objectUrl);
      },
      () => {
        if (!cancelled) {
          setFailed(true);
        }
      },
      { responseType: 'blob' },
    );
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [url, isPdf, authRef]);

  return (
    <div className="lageplan-thumb">
      {src ? (
        <img src={src} alt="" />
      ) : isPdf ? (
        <FileEarmarkPdf size={26} />
      ) : failed || !url ? (
        'No preview'
      ) : (
        <Spinner animation="border" size="sm" />
      )}
    </div>
  );
};

type RenameState = { plan: WizardLageplan; name: string };

type LageplanWizardDialogsProps = {
  confirmAction: WizardConfirmAction | null;
  renaming: RenameState | null;
  measurePointCount: number;
  isProcessing: boolean;
  pointsOnPlan: (planId: number) => number;
  onConfirmActionChange: (action: WizardConfirmAction | null) => void;
  onDeletePlan: (plan: WizardLageplan) => void;
  onClearMeasurePoints: () => void;
  onRenamingChange: Dispatch<SetStateAction<RenameState | null>>;
  onRenamePlan: (plan: WizardLageplan, name: string) => void;
};

export const LageplanWizardDialogs = ({
  confirmAction,
  renaming,
  measurePointCount,
  isProcessing,
  pointsOnPlan,
  onConfirmActionChange,
  onDeletePlan,
  onClearMeasurePoints,
  onRenamingChange,
  onRenamePlan,
}: LageplanWizardDialogsProps) => {
  const { t } = useTranslation();
  return (
    <>
      <ConfirmDialog
        show={confirmAction !== null}
        testId="lageplan-wizard-confirm"
        title={
          confirmAction?.kind === 'plan'
            ? t('lageplan_wizard_remove_plan_title')
            : t('lageplan_wizard_clear_title')
        }
        message={
          confirmAction?.kind === 'plan'
            ? t('lageplan_wizard_remove_plan_message', {
                plan: planLabel(confirmAction.plan),
                count: pointsOnPlan(confirmAction.plan.id),
              })
            : t('lageplan_wizard_clear_message', { count: measurePointCount })
        }
        confirmLabel={
          confirmAction?.kind === 'plan'
            ? t('lageplan_wizard_remove_plan_button')
            : t('lageplan_wizard_clear_button')
        }
        cancelLabel={t('lageplan_wizard_cancel')}
        confirming={isProcessing}
        onCancel={() => onConfirmActionChange(null)}
        onConfirm={() => {
          if (confirmAction?.kind === 'plan') {
            onDeletePlan(confirmAction.plan);
          } else if (confirmAction?.kind === 'points') {
            onClearMeasurePoints();
          }
        }}
      />

      <ConfirmDialog
        show={renaming !== null}
        testId="lageplan-wizard-rename"
        title="Rename Lageplan"
        message={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (renaming) {
                onRenamePlan(renaming.plan, renaming.name);
              }
            }}
          >
            <label
              htmlFor="lageplan-rename-input"
              className="form-label lageplan-rename-label"
            >
              Name (empty: the file name is shown)
            </label>
            <input
              id="lageplan-rename-input"
              className="form-control"
              autoFocus
              maxLength={255}
              value={renaming?.name ?? ''}
              placeholder={renaming?.plan.url?.split('/').pop() ?? ''}
              data-testid="lageplan-wizard-rename-input"
              disabled={isProcessing}
              onChange={(event) =>
                onRenamingChange((current) =>
                  current ? { ...current, name: event.target.value } : current,
                )
              }
            />
          </form>
        }
        confirmLabel="Save"
        cancelLabel="Cancel"
        danger={false}
        confirming={isProcessing}
        onCancel={() => onRenamingChange(null)}
        onConfirm={() => {
          if (renaming) {
            onRenamePlan(renaming.plan, renaming.name);
          }
        }}
      />
    </>
  );
};
