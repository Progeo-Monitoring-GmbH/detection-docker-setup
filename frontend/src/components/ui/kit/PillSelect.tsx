import type { ReactNode } from 'react';

export type PillSelectOption = { value: string; label: string };

type PillSelectProps = {
  /** Text before the field (it labels the select). */
  label?: ReactNode;
  options: PillSelectOption[];
  value: string;
  onChange: (value: string) => void;
  title?: string;
};

/**
 * A dropdown in the pill style of SegmentedControl: the selected value is
 * the active pill on the grey track - for choices with too many options for
 * a segment row (the plan's step width, ...).
 */
const PillSelect = ({ label, options, value, onChange, title }: PillSelectProps) => {
  return (
    <label
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: 0,
        color: '#6E6868',
        fontSize: 12.5,
        fontWeight: 500,
      }}
    >
      {label}
      <span
        style={{
          display: 'inline-flex',
          background: 'var(--progeo-track)',
          borderRadius: 'var(--progeo-radius-pill)',
          padding: 3,
        }}
      >
        <select
          className="form-select"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          style={{
            width: 'auto',
            height: 32,
            padding: '0 34px 0 14px',
            border: 'none',
            borderRadius: 'var(--progeo-radius-pill)',
            backgroundColor: 'var(--progeo-surface)',
            backgroundPosition: 'right 12px center',
            boxShadow: 'var(--progeo-shadow-chrome)',
            color: 'var(--progeo-blue)',
            fontFamily: 'inherit',
            fontSize: 12.5,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
};

export default PillSelect;
