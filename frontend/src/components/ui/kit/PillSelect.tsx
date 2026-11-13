import type { ReactNode } from 'react';
import './kit.css';

type PillSelectOption = { value: string; label: string };

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
const PillSelect = ({ label, options, value, onChange, title }: PillSelectProps) => (
  <label title={title} className="progeo-pill-select">
    {label}
    <span className="progeo-pill-track">
      <select className="form-select" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  </label>
);

export default PillSelect;
