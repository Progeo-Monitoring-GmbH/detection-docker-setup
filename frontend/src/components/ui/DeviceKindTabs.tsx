import {
  type ReactNode,
  type TouchEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Nav } from 'react-bootstrap';
import { ArrowLeftRight } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import type { DeviceKind } from '../../main/locationTypes';
import {
  dismissHint,
  hintDismissed,
  PRELOAD_FALLBACK_MS,
  swipeIgnoredAt,
  tabSwipeTarget,
} from './deviceKindTabsLogic';
import useIsMobile from './useIsMobile';
import { useLatestRef } from './useLatestRef';
import './DeviceKindTabs.css';

export { useDeviceKindTab } from './deviceKindTabsLogic';

/** What a tab's panel is told: whether it is shown, how to say it has
 * loaded (the other tabs preload then) and what to load (`loadKey`, e.g.
 * the period - a hidden panel gets a new one only once the visible one has
 * loaded it). */
export type PanelContext<K extends string> = {
  visible: boolean;
  onReady: () => void;
  loadKey: K;
};

type DeviceKindTabsProps<K extends string> = {
  /** The kinds of the location, in tab order - one: no tabs. */
  kinds: readonly DeviceKind[];
  active: DeviceKind;
  onSelect: (kind: DeviceKind) => void;
  loadKey: K;
  renderPanel: (kind: DeviceKind, ctx: PanelContext<K>) => ReactNode;
  testId: string;
};

const COARSE_POINTER = '(pointer: coarse)';
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const LABEL_KEYS: Record<DeviceKind, string> = {
  leak: 'status_tab_leak',
  climate: 'status_tab_climate',
};
const noop = () => {};

/**
 * The tabs "Leckage" / "Klima" of a location with both kinds of devices
 * (status and analysis pages). Loading time matters most: the active panel
 * loads alone; once it reports `onReady` (or after PRELOAD_FALLBACK_MS) the
 * other panels mount hidden and load in the background - and stay mounted,
 * so a switch only shows them. On touch devices a horizontal swipe over the
 * content switches too, and the other tab pulses until the first switch.
 */
const DeviceKindTabs = <K extends string>({
  kinds,
  active,
  onSelect,
  loadKey,
  renderPanel,
  testId,
}: DeviceKindTabsProps<K>) => {
  const { t } = useTranslation();
  const coarsePointer = useIsMobile(COARSE_POINTER);
  const reducedMotion = useIsMobile(REDUCED_MOTION);
  const tabbed = kinds.length > 1;
  const kindsKey = kinds.join(',');

  const [mounted, setMounted] = useState<readonly DeviceKind[]>([active]);
  // The load key each panel got last - the visible one always the current.
  const [keys, setKeys] = useState<Partial<Record<DeviceKind, K>>>({ [active]: loadKey });
  // The load key the hidden panels may load (the visible one has it).
  const [released, setReleased] = useState<K | null>(null);
  const [hintDone, setHintDone] = useState(hintDismissed);
  const [slide, setSlide] = useState<'next' | 'prev' | null>(null);
  if (!mounted.includes(active)) {
    setMounted((prev) => [...prev, active]);
  }
  if (keys[active] !== loadKey) {
    setKeys((prev) => ({ ...prev, [active]: loadKey }));
  }

  const release = useCallback(
    (key: K) => {
      const all = kindsKey.split(',') as DeviceKind[];
      setReleased(key);
      setMounted(all);
      setKeys(Object.fromEntries(all.map((kind) => [kind, key])) as Record<DeviceKind, K>);
    },
    [kindsKey],
  );

  // The load key each panel reported ready for.
  const ready = useRef<Partial<Record<DeviceKind, K>>>({});
  const latest = useLatestRef({ active, loadKey, released, release });
  const handlers = useRef(new Map<string, () => void>());
  const readyFor = (kind: DeviceKind, key: K) => {
    const id = `${kind}|${key}`;
    let handler = handlers.current.get(id);
    if (!handler) {
      handler = () => {
        ready.current[kind] = key;
        const now = latest.current;
        if (kind === now.active && key === now.loadKey && now.released !== key) {
          now.release(key);
        }
      };
      handlers.current.set(id, handler);
    }
    return handler;
  };

  // The visible panel has what it needs (maybe from before, while hidden) -
  // else the others load after PRELOAD_FALLBACK_MS anyway.
  useEffect(() => {
    if (!tabbed || released === loadKey) {
      return undefined;
    }
    if (ready.current[active] === loadKey) {
      release(loadKey);
      return undefined;
    }
    const timer = window.setTimeout(() => release(loadKey), PRELOAD_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [active, loadKey, release, released, tabbed]);

  // A panel shown again: its charts (Plotly's resize handler) measure anew -
  // hidden they had no size.
  const shownBefore = useRef(active);
  useEffect(() => {
    if (shownBefore.current !== active) {
      shownBefore.current = active;
      window.dispatchEvent(new Event('resize'));
    }
  }, [active]);

  const select = (kind: DeviceKind) => {
    if (kind === active || !kinds.includes(kind)) {
      return;
    }
    dismissHint();
    setHintDone(true);
    setSlide(kinds.indexOf(kind) > kinds.indexOf(active) ? 'next' : 'prev');
    onSelect(kind);
  };

  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const swipeable = tabbed && coarsePointer;
  const onTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    swipeStart.current =
      touch && event.touches.length === 1 && !swipeIgnoredAt(event.target, event.currentTarget)
        ? { x: touch.clientX, y: touch.clientY }
        : null;
  };
  const onTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch) {
      return;
    }
    const target = tabSwipeTarget(kinds, active, touch.clientX - start.x, touch.clientY - start.y);
    if (target) {
      select(target);
    }
  };

  if (!tabbed) {
    return <>{renderPanel(kinds[0] ?? active, { visible: true, onReady: noop, loadKey })}</>;
  }

  const showHint = coarsePointer && !hintDone;
  return (
    <div className="device-kind-tabs" data-testid={testId}>
      <Nav
        variant="tabs"
        className="device-kind-tabs__nav"
        activeKey={active}
        onSelect={(key) => key && select(key as DeviceKind)}
      >
        {kinds.map((kind) => {
          const hinted = showHint && kind !== active;
          return (
            <Nav.Item key={kind}>
              <Nav.Link
                as="button"
                type="button"
                eventKey={kind}
                data-testid={`${testId}-tab-${kind}`}
                className={hinted && !reducedMotion ? 'device-kind-tab--pulse' : undefined}
              >
                {t(LABEL_KEYS[kind])}
                {hinted && reducedMotion ? (
                  <ArrowLeftRight
                    className="device-kind-tab__hint"
                    role="img"
                    aria-label={t('status_tab_swipe_hint')}
                  />
                ) : null}
              </Nav.Link>
            </Nav.Item>
          );
        })}
      </Nav>
      <div
        className="device-kind-tabs__content"
        onTouchStart={swipeable ? onTouchStart : undefined}
        onTouchEnd={swipeable ? onTouchEnd : undefined}
      >
        {kinds
          .filter((kind) => mounted.includes(kind))
          .map((kind) => {
            const visible = kind === active;
            const key = visible ? loadKey : (keys[kind] ?? loadKey);
            return (
              <div
                key={kind}
                hidden={!visible}
                data-testid={`${testId}-panel-${kind}`}
                className={visible && slide ? `device-kind-tabs__panel--slide-${slide}` : undefined}
              >
                {renderPanel(kind, { visible, onReady: readyFor(kind, key), loadKey: key })}
              </div>
            );
          })}
      </div>
    </div>
  );
};

export default DeviceKindTabs;
