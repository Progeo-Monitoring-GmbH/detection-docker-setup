import { useLayoutEffect, useRef, useState } from 'react';
import PillButton from './PillButton';
import './kit.css';
import { KeyChip } from '../KeyHints';
import { childTestId } from '../../../testIds';
import useIsMobile from '../useIsMobile';

type SegmentedOption = {
  value: string;
  label: string;
  /** The key that picks the option (handled by the page) - shown as a chip. */
  hotkey?: string;
  /** Hover text, e.g. how the key works. */
  title?: string;
};

type SegmentedControlProps = {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  /** Block switching while a request is running (e.g. a heavy stats scan). */
  disabled?: boolean;
  /**
   * data-testid of the track; each option is "<testId>-option" with its value
   * as data-test-key. On a phone where the pills don't fit in one row the
   * control is a dropdown instead: "<testId>-select" (values as above).
   */
  testId?: string;
};

/** Gap and padding of .progeo-pill-track (kit.css). */
const TRACK_GAP = 3;
const TRACK_PADDING = 3;

/**
 * The width the pills take side by side in one row, at their own size: the
 * pills measured for a moment without wrapping and without the phone rule
 * that stretches them (kit.css .progeo-pill-track--measure).
 */
const naturalWidthOf = (track: HTMLElement) => {
  track.classList.add('progeo-pill-track--measure');
  const pills = Array.from(track.children) as HTMLElement[];
  const pillsWidth = pills.reduce((sum, pill) => sum + pill.getBoundingClientRect().width, 0);
  track.classList.remove('progeo-pill-track--measure');
  // Plus the track's gaps and padding (kit.css: 3px each).
  return pillsWidth + TRACK_GAP * Math.max(0, pills.length - 1) + 2 * TRACK_PADDING;
};

/** The content width of the element the control sits in. */
const availableWidthOf = (parent: HTMLElement) => {
  const style = window.getComputedStyle(parent);
  return (
    parent.clientWidth -
    (parseFloat(style.paddingLeft) || 0) -
    (parseFloat(style.paddingRight) || 0)
  );
};

/**
 * The pill-track filter/toggle group (view switchers, sequence controls, ...).
 * On a phone, when the pills would wrap into several rows (the round track
 * then looks broken), it shows the options as a dropdown in the PillSelect
 * style instead.
 */
const SegmentedControl = ({
  options,
  value,
  onChange,
  disabled = false,
  testId,
}: SegmentedControlProps) => {
  const isPhone = useIsMobile();
  const rootRef = useRef<HTMLElement | null>(null);
  const labelsKey = options.map((option) => `${option.label}\u0000${option.hotkey ?? ''}`).join('\u0001');
  // The pills' one-row width, measured while they are shown (per label set).
  const [natural, setNatural] = useState<{ key: string; width: number } | null>(null);
  const [available, setAvailable] = useState<number | null>(null);

  const collapsed =
    isPhone &&
    natural !== null &&
    natural.key === labelsKey &&
    available !== null &&
    natural.width > available + 1.5;

  // Measure the pills before the browser paints them.
  useLayoutEffect(() => {
    if (!isPhone || collapsed || !rootRef.current) {
      return;
    }
    const width = naturalWidthOf(rootRef.current);
    if (natural === null || natural.key !== labelsKey || Math.abs(natural.width - width) > 0.5) {
      setNatural({ key: labelsKey, width });
    }
  });

  // Follow the room the control has (rotation, resizing, a sidebar).
  useLayoutEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!isPhone || !parent) {
      return undefined;
    }
    const update = () => setAvailable(availableWidthOf(parent));
    update();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [isPhone, collapsed]);

  if (collapsed) {
    return (
      <label
        ref={(element) => {
          rootRef.current = element;
        }}
        className="progeo-pill-select progeo-segmented-select"
        data-testid={testId}
      >
        <span className="progeo-pill-track">
          <select
            className="form-select"
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            data-testid={childTestId(testId, 'select')}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value} title={option.title}>
                {option.label}
              </option>
            ))}
          </select>
        </span>
      </label>
    );
  }

  return (
    <div
      ref={(element) => {
        rootRef.current = element;
      }}
      className="progeo-pill-track"
      data-testid={testId}
    >
      {options.map((option) => (
        <PillButton
          key={option.value}
          label={option.label}
          icon={option.hotkey ? <KeyChip>{option.hotkey}</KeyChip> : undefined}
          title={option.title}
          active={option.value === value}
          onClick={() => onChange(option.value)}
          disabled={disabled}
          testId={childTestId(testId, 'option')}
          testKey={testId ? option.value : undefined}
        />
      ))}
    </div>
  );
};

export default SegmentedControl;
