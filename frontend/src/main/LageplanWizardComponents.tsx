import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { Spinner } from 'react-bootstrap';
import { CheckLg, FileEarmarkPdf } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { getBackendUrl } from '../backendUrl';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import PanelCard from '../components/ui/kit/PanelCard';
import { WIZARD_ANCHORS, type WizardStep } from './lageplanWizardAnchors';
import type {
  WizardConfirmAction,
  WizardLageplan,
} from './lageplanWizardUtils';
import { getFileExt, planLabel } from './lageplanWizardUtils';

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
  const targeted = useContext(TargetStepContext) === WIZARD_ANCHORS[step];
  return (
    <PanelCard
      id={WIZARD_ANCHORS[step]}
      className={targeted ? 'lageplan-step--target' : undefined}
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
      actions={actions}
      testId={`lageplan-wizard-step-${number}`}
    >
      {children}
    </PanelCard>
  );
};

export const LageplanThumb = ({ url }: { url?: string | null }) => {
  const auth = useAuth();
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
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
  }, [url, isPdf]);

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
