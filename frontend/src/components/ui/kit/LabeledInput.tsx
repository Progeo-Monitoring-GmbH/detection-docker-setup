import type { ChangeEvent } from 'react';

type LabeledInputProps = {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  type?: string;
  title?: string;
};

/** Uppercase small label above a soft-surface input, as used on the Objekt/Einstellungen panels. */
const LabeledInput = ({
  label,
  value,
  onChange,
  readOnly = false,
  type = 'text',
  title,
}: LabeledInputProps) => {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      <span
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
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange?.(event.target.value)}
        style={{
          height: 40,
          border: 'none',
          borderRadius: 11,
          background: 'var(--progeo-surface)',
          boxShadow: '0 1px 4px rgba(11, 54, 89, .09)',
          padding: '0 13px',
          fontFamily: 'inherit',
          fontSize: 14,
          fontWeight: 400,
          color: 'var(--progeo-blue)',
          width: '100%',
        }}
      />
    </label>
  );
};

export default LabeledInput;
