import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

interface Props<T> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onPick: (item: T) => void;
  fetchItems: (query: string) => Promise<T[]>;
  renderItem: (item: T) => ReactNode;
  keyOf: (item: T) => string;
  placeholder?: string;
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** Show suggestions as soon as the empty field is focused. */
  openOnFocus?: boolean;
}

/**
 * Type-ahead over history. Suggestions are advisory: the typed value always
 * stands on its own, so a brand new payee never has to be fought with.
 */
export function Autocomplete<T>({
  label,
  value,
  onChange,
  onPick,
  fetchItems,
  renderItem,
  keyOf,
  placeholder,
  autoFocus,
  inputRef,
  openOnFocus = false,
}: Props<T>) {
  const [items, setItems] = useState<T[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const localRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? localRef;

  // Debounced lookup. 120ms is short enough to feel instant while typing on a
  // phone and long enough to avoid a request per keystroke.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchItems(value)
        .then((result) => {
          if (!cancelled) {
            setItems(result);
            setActive(-1);
          }
        })
        .catch(() => {
          if (!cancelled) setItems([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, open, fetchItems]);

  useEffect(() => {
    if (!open) return;
    const onDocumentPointerDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown);
  }, [open]);

  const choose = (item: T) => {
    onPick(item);
    setOpen(false);
    setActive(-1);
  };

  return (
    <div className="field" ref={boxRef}>
      <label htmlFor={`${listId}-input`}>{label}</label>
      <input
        id={`${listId}-input`}
        ref={ref}
        type="text"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (openOnFocus || value !== '') setOpen(true);
        }}
        onKeyDown={(event) => {
          if (!open || items.length === 0) {
            if (event.key === 'ArrowDown') setOpen(true);
            return;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((i) => (i + 1) % items.length);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
          } else if (event.key === 'Enter' && active >= 0) {
            event.preventDefault();
            choose(items[active]!);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
      />

      {open && items.length > 0 && (
        <div className="suggestions" id={listId} role="listbox">
          {items.map((item, index) => (
            <button
              key={keyOf(item)}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={index === active}
              data-active={index === active}
              className="suggestion"
              // pointerdown fires before the input's blur, so the pick is not
              // lost to the dropdown closing first.
              onPointerDown={(event) => {
                event.preventDefault();
                choose(item);
              }}
              onMouseEnter={() => setActive(index)}
            >
              {renderItem(item)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
