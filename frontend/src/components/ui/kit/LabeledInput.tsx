import { useId, type ChangeEvent } from 'react';

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
}: LabeledInputProps) => {
  const labelId = useId();
  // Firefox ignores autocomplete for address capture and recognises the
  // fields by their <label> text ("Straße", "PLZ", ...) - without autofill
  // the input is named via aria-labelledby, which its heuristics don't read.
  const noAutofill = autoComplete === NO_AUTOFILL;
  const Wrapper = noAutofill ? 'div' : 'label';

  return (
    <Wrapper style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      <span
        id={labelId}
        style={{
          fontSize: 11,
          letterSpacing: '.07em',
          textTransform: 'uppercase',
          color: '#8B8383',
          fontWeight: 500,
        }}
      >
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
        style={{
          height: 40,
          border: 'none',
          borderRadius: 11,
          // Read-only fields drop the input look, so they don't invite typing.
          background: readOnly ? 'transparent' : 'var(--progeo-surface)',
          boxShadow: readOnly
            ? 'inset 0 0 0 1px rgba(11, 54, 89, .12)'
            : '0 1px 4px rgba(11, 54, 89, .09)',
          padding: '0 13px',
          fontFamily: 'inherit',
          fontSize: 14,
          fontWeight: 400,
          color: readOnly ? '#6E6868' : 'var(--progeo-blue)',
          cursor: readOnly ? 'default' : undefined,
          width: '100%',
        }}
      />
    </Wrapper>
  );
};

export default LabeledInput;
