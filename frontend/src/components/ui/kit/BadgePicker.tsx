import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Spinner } from 'react-bootstrap';
import { XLg } from 'react-bootstrap-icons';
import { childTestId, repeatedTestId } from '../../../testIds';
import './BadgePicker.css';

/**
 * Pick several items by searching: a text field whose matches drop down
 * below it (click or Enter adds one), the picked items as badges in front of
 * it (a click on a badge's x removes it, Backspace in the empty field the
 * last one). `search` answers the matches of a text - local filtering or a
 * request; `fromText` turns typed or pasted text into items directly (e.g.
 * project numbers "4711, 4712"), on Enter / comma / paste.
 */
type BadgePickerProps<T> = {
  selected: T[];
  onChange: (items: T[]) => void;
  keyOf: (item: T) => string | number;
  /** The badge of a picked item. */
  badgeLabel: (item: T) => ReactNode;
  /** A match in the list. */
  optionLabel: (item: T) => ReactNode;
  search: (text: string) => Promise<T[]> | T[];
  /** Items straight from typed / pasted text - none: only matches are added. */
  fromText?: (text: string) => T[];
  placeholder?: string;
  /** Shown while the text has no match. */
  emptyLabel?: string;
  /** Debounce of `search` (ms) - for a request; 0 for local filtering. */
  delay?: number;
  invalid?: boolean;
  testId: string;
};

const BadgePicker = <T,>({
  selected,
  onChange,
  keyOf,
  badgeLabel,
  optionLabel,
  search,
  fromText,
  placeholder,
  emptyLabel,
  delay = 250,
  invalid = false,
  testId,
}: BadgePickerProps<T>) => {
  const [text, setText] = useState('');
  const [matches, setMatches] = useState<T[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  });

  const selectedKeys = new Set(selected.map(keyOf));
  const shown = matches.filter((item) => !selectedKeys.has(keyOf(item)));

  // A new text: searching while it has a query, no matches without one - set
  // where the text changes (changeText), the request below.
  const changeText = (value: string) => {
    setText(value);
    if (value.trim()) {
      setSearching(true);
    } else {
      setMatches([]);
      setSearching(false);
    }
  };

  // The matches of the text - answers for an older text are dropped.
  useEffect(() => {
    const query = text.trim();
    if (!query) {
      return undefined;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      void Promise.resolve(searchRef.current(query))
        .then((found) => {
          if (current) {
            setMatches(found);
            setActive(0);
          }
        })
        .catch(() => current && setMatches([]))
        .finally(() => current && setSearching(false));
    }, delay);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [text, delay]);

  const add = (items: T[]) => {
    const fresh = items.filter((item) => !selectedKeys.has(keyOf(item)));
    if (fresh.length) {
      onChange([...selected, ...fresh]);
    }
    changeText('');
  };

  const remove = (key: string | number) => onChange(selected.filter((item) => keyOf(item) !== key));

  const addFromText = (value: string) => {
    const items = fromText?.(value) ?? [];
    if (items.length) {
      add(items);
      return true;
    }
    return false;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActive((index) => {
        const next = index + (event.key === 'ArrowDown' ? 1 : -1);
        return Math.max(0, Math.min(shown.length - 1, next));
      });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (open && shown[active]) {
        add([shown[active]]);
      } else {
        addFromText(text);
      }
    } else if (event.key === ',' && fromText) {
      if (addFromText(text)) {
        event.preventDefault();
      }
    } else if (event.key === 'Backspace' && !text && selected.length) {
      remove(keyOf(selected[selected.length - 1]));
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (fromText && /[,;\s]/.test(pasted.trim()) && addFromText(pasted)) {
      event.preventDefault();
    }
  };

  const showList = open && text.trim().length > 0;

  return (
    <div className={`badge-picker${invalid ? ' badge-picker--invalid' : ''}`} data-testid={testId}>
      <div className="badge-picker-field form-control">
        {selected.map((item) => (
          <span key={keyOf(item)} className="badge-picker-badge" {...repeatedTestId(`${testId}-badge`, keyOf(item))}>
            {badgeLabel(item)}
            <button
              type="button"
              className="badge-picker-remove"
              aria-label="remove"
              onClick={() => remove(keyOf(item))}
              {...repeatedTestId(`${testId}-remove`, keyOf(item))}
            >
              <XLg size={9} />
            </button>
          </span>
        ))}
        <input
          value={text}
          placeholder={selected.length ? undefined : placeholder}
          onChange={(event) => {
            changeText(event.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          className="badge-picker-input"
          data-testid={childTestId(testId, 'input')}
        />
        {searching && <Spinner size="sm" animation="border" className="badge-picker-spinner" />}
      </div>
      {showList && (
        <ul id={listId} role="listbox" className="badge-picker-list" data-testid={childTestId(testId, 'list')}>
          {shown.map((item, index) => (
            <li
              key={keyOf(item)}
              role="option"
              aria-selected={index === active}
              className={`badge-picker-option${index === active ? ' badge-picker-option--active' : ''}`}
              // Before the input's blur closes the list.
              onMouseDown={(event) => {
                event.preventDefault();
                add([item]);
              }}
              onMouseEnter={() => setActive(index)}
              {...repeatedTestId(`${testId}-option`, keyOf(item))}
            >
              {optionLabel(item)}
            </li>
          ))}
          {!searching && shown.length === 0 && emptyLabel && (
            <li className="badge-picker-empty">{emptyLabel}</li>
          )}
        </ul>
      )}
    </div>
  );
};

export default BadgePicker;
