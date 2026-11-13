import { useId, type ChangeEvent } from 'react';
import './kit.css';

const NO_AUTOFILL = 'progeo-no-autofill';

type LabeledInputProps = {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  type?: string;
  title?: string;
  /**
   * Defaults to a non-standard token: Chrome ignores `off` for address-like
   * fields and would offer to save the Objekt address/contact data as the
   * user's own address when navigating away.
   */
  autoComplete?: string;
  /** data-testid of the input. */
  testId?: string;
};

/** Uppercase small label above a soft-surface input, as used on the Objekt/Einstellungen panels. */
const LabeledInput = ({
  label,
  value,
  onChange,
  readOnly = false,
  type = 'text',
  title,
  autoComplete = NO_AUTOFILL,
  testId,
}: LabeledInputProps) => {
  const labelId = useId();
  // Firefox ignores autocomplete for address capture and recognises the
  // fields by their <label> text ("Straße", "PLZ", ...) - without autofill
  // the input is named via aria-labelledby, which its heuristics don't read.
  const noAutofill = autoComplete === NO_AUTOFILL;
  const Wrapper = noAutofill ? 'div' : 'label';

  return (
    <Wrapper className="progeo-field">
      <span id={labelId} className="progeo-field-label">
        {label}
      </span>
      <input
        type={type}
        value={value}
        readOnly={readOnly}
        title={title}
        autoComplete={autoComplete}
        aria-labelledby={noAutofill ? labelId : undefined}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange?.(event.target.value)}
        className="progeo-field-input"
        data-testid={testId}
      />
    </Wrapper>
  );
};

export default LabeledInput;
