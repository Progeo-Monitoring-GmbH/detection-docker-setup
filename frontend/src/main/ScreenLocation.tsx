import { Badge } from 'react-bootstrap';
import { BoxArrowUpRight, ExclamationTriangle } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import {
  imageUrl,
  portalHref,
  stepTarget,
  stepsFor,
  type ModalStep,
  type ScreenDevice,
  type ScreenFailure,
  type ScreenImage,
  type ScreenModal,
} from './screenReview';
import './ScreenLocation.css';

/** A step readable: "Klick auf staff-user-edit [2]". */
const StepText = ({ step }: { step: ModalStep }) => {
  const { t } = useTranslation();
  const value =
    step.do === 'wait'
      ? String(step.ms ?? 0)
      : step.do === 'upload'
        ? (step.file ?? '')
        : (step.value ?? '');
  return (
    <>
      {t(`screens_step_${step.do}`, {
        target: stepTarget(step),
        value,
        interpolation: { escapeValue: false },
      })}
    </>
  );
};

/** How a dialog is opened on its page: the steps in order, then the dialog's test id. */
export const ModalSteps = ({
  modal,
  device,
  testKey,
}: {
  modal: ScreenModal;
  device: ScreenDevice;
  testKey: string;
}) => {
  const { t } = useTranslation();
  const steps = stepsFor(modal, device);
  return (
    <div
      className="screen-location-steps"
      data-testid="screen-modal-steps"
      data-test-key={testKey}
    >
      <span className="screen-location-steps-label">
        {t('screens_opened_by')}
      </span>
      {steps.length ? (
        <ol className="screen-location-step-list">
          {steps.map((step, index) => (
            // The steps never change order - the index is their identity.
            // eslint-disable-next-line react/no-array-index-key
            <li key={index} className="screen-location-step">
              <StepText step={step} />
            </li>
          ))}
        </ol>
      ) : (
        <span>–</span>
      )}
      {modal.testId && (
        <span className="screen-location-dialog-id">
          → [data-testid="{modal.testId}"]
        </span>
      )}
      {modal.scenario && (
        <Badge bg="light" text="dark">
          {t('screens_scenario', { name: modal.scenario })}
        </Badge>
      )}
    </div>
  );
};

/** The address as a link into the portal (a new tab) - plain text when it is none. */
const UrlLink = ({ url, testKey }: { url: string | null; testKey: string }) => {
  const { t } = useTranslation();
  const href = portalHref(url);
  if (!href) {
    return <span className="screen-location-url">{url ?? '–'}</span>;
  }
  return (
    <a
      className="screen-location-url"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={t('screens_open_page')}
      data-testid="screen-url"
      data-test-key={testKey}
    >
      {href}
      <BoxArrowUpRight className="screen-location-url-icon" aria-hidden />
    </a>
  );
};

/**
 * Where a screenshot was taken: its URL (a link that opens the page in the
 * portal) and - for a dialog - which dialog and how it is opened there.
 */
const ScreenLocation = ({
  image,
}: {
  image: Pick<ScreenImage, 'file' | 'device' | 'url' | 'path' | 'modal'>;
}) => {
  const { t } = useTranslation();
  return (
    <>
      <UrlLink url={imageUrl(image)} testKey={image.file} />
      {image.modal && (
        <>
          <Badge
            bg="info"
            className="screen-location-dialog"
            data-testid="screen-modal"
            data-test-key={image.file}
          >
            {t('screens_dialog')}: {image.modal.name}
          </Badge>
          <ModalSteps
            modal={image.modal}
            device={image.device}
            testKey={image.file}
          />
        </>
      )}
    </>
  );
};

/** The screenshots the capture could not take (dialogs that did not open) - and why. */
export const ScreenFailures = ({ failures }: { failures: ScreenFailure[] }) => {
  const { t } = useTranslation();
  if (!failures.length) {
    return null;
  }
  return (
    <details className="screen-failures" data-testid="screens-failures">
      <summary>
        <ExclamationTriangle className="me-1" />
        {t('screens_failures', { count: failures.length })}
      </summary>
      <ul className="screen-failure-list">
        {failures.map((failure) => (
          <li
            key={failure.file}
            className="screen-failure"
            data-testid="screens-failure"
            data-test-key={failure.file}
          >
            <span className="screen-failure-name">
              {failure.action}
              {failure.modal ? ` › ${failure.modal.name}` : ''}
            </span>
            <span className="screen-failure-meta">
              {t(`screens_device_${failure.device}`)} ·{' '}
              {t(`screens_role_${failure.role}`)} ·{' '}
              {failure.language.toUpperCase()}
            </span>
            <UrlLink url={failure.url} testKey={failure.file} />
            {failure.modal && (
              <ModalSteps
                modal={failure.modal}
                device={failure.device}
                testKey={failure.file}
              />
            )}
            <span className="screen-failure-reason">{failure.reason}</span>
          </li>
        ))}
      </ul>
    </details>
  );
};

export default ScreenLocation;
