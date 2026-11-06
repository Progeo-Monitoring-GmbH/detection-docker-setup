import { type CSSProperties, Fragment, useEffect, useState } from 'react';

/**
 * Keyboard hints: which keys a page or plot reacts to, as <kbd> chips. The
 * handlers announce a key they processed (announceKey) - its chip lights up
 * for a moment, so a press shows whether it did anything.
 */

const bus = new EventTarget();

/** A handler processed the key press of hint `id` (KeyHint.id). */
export const announceKey = (id: string) => {
  bus.dispatchEvent(new CustomEvent<string>('key', { detail: id }));
};

/** The id of the hint announced last - for `ms` after the press, else null. */
export const useFlashedKey = (ms = 700) => {
  const [flashed, setFlashed] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (event: Event) => {
      setFlashed((event as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setFlashed(null), ms);
    };
    bus.addEventListener('key', onKey);
    return () => {
      bus.removeEventListener('key', onKey);
      clearTimeout(timer);
    };
  }, [ms]);
  return flashed;
};

export type KeyHint = {
  /** What handlers announce (announceKey); hints without one never light up (mouse). */
  id?: string;
  /** The keys, each a chip: ["Strg", "Z"] reads "Strg + Z"; "←/→" stays one chip. */
  keys: string[];
  label: string;
};

const KBD: CSSProperties = {
  display: 'inline-block',
  minWidth: 20,
  padding: '0 5px',
  borderRadius: 4,
  border: '1px solid var(--progeo-warm-gray-3, #d6d1ce)',
  borderBottomWidth: 2,
  background: 'var(--progeo-surface, #fff)',
  color: 'var(--progeo-blue, #0b3659)',
  fontFamily: 'inherit',
  fontSize: 11,
  fontWeight: 600,
  lineHeight: '17px',
  textAlign: 'center',
  transition: 'background 120ms, border-color 120ms',
};

const KBD_FLASHED: CSSProperties = {
  background: 'rgba(235, 99, 59, 0.2)',
  borderColor: '#eb633b',
};

type KeyHintsProps = {
  hints: KeyHint[];
  /** Shown before the chips, e.g. "Tastatur". */
  title?: string;
  /** Off: dimmed, with `inactiveNote` - the keys only work once e.g. the plot has the focus. */
  active?: boolean;
  inactiveNote?: string;
  className?: string;
  style?: CSSProperties;
};

const KeyHints = ({ hints, title, active = true, inactiveNote, className, style }: KeyHintsProps) => {
  const flashed = useFlashedKey();
  return (
    <div
      className={`d-flex flex-wrap align-items-center ${className ?? ''}`}
      style={{ columnGap: 14, rowGap: 4, fontSize: 11.5, color: '#6E6868', opacity: active ? 1 : 0.6, ...style }}
      data-testid="key-hints"
    >
      {title && <span className="fw-semibold">{title}</span>}
      {hints.map((hint) => {
        const lit = active && hint.id != null && hint.id === flashed;
        return (
          <span
            key={hint.label}
            className="d-inline-flex align-items-center gap-1"
            data-testid="key-hint"
            data-lit={lit ? 'true' : undefined}
          >
            {hint.keys.map((key, index) => (
              <Fragment key={key}>
                {index > 0 && <span>+</span>}
                <kbd style={{ ...KBD, ...(lit ? KBD_FLASHED : {}) }}>{key}</kbd>
              </Fragment>
            ))}
            <span>{hint.label}</span>
          </span>
        );
      })}
      {!active && inactiveNote && <span className="fst-italic">{inactiveNote}</span>}
    </div>
  );
};

export default KeyHints;
