// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useAnalyseHotkeys from './useAnalyseHotkeys';
import useSensorSelection from './useSensorSelection';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const press = (key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', {
    key,
    cancelable: true,
    ...init,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
};

describe('useAnalyseHotkeys', () => {
  const plans = [{ id: 11 }, { id: 12 }];
  type Props = Parameters<typeof useAnalyseHotkeys>[0];
  const Harness = (props: Props) => {
    useAnalyseHotkeys(props);
    return null;
  };
  const render = (props: Partial<Props> = {}) => {
    const handlers = {
      onFrameTime: vi.fn(),
      onPlan: vi.fn(),
      onRangeClear: vi.fn(),
    };
    act(() =>
      root.render(
        <Harness
          frameSeconds={[10, 20, 30]}
          frameTime={null}
          planHotkeys
          plans={plans}
          rangeClear
          {...handlers}
          {...props}
        />,
      ),
    );
    return handlers;
  };

  it('steps the frames with the arrow keys', () => {
    const { onFrameTime } = render();
    const event = press('ArrowLeft');
    expect(event.defaultPrevented).toBe(true);
    expect(onFrameTime).toHaveBeenCalledWith(20_000);
    press('ArrowRight');
    expect(onFrameTime).toHaveBeenCalledTimes(1);
  });

  it('leaves the arrows alone without frames', () => {
    const { onFrameTime } = render({ frameSeconds: [] });
    expect(press('ArrowLeft').defaultPrevented).toBe(false);
    expect(onFrameTime).not.toHaveBeenCalled();
  });

  it('picks a plan with 1-9, only while plan keys are on', () => {
    const { onPlan } = render();
    press('2');
    expect(onPlan).toHaveBeenCalledWith(12);
    expect(press('3').defaultPrevented).toBe(false);
    const off = render({ planHotkeys: false });
    press('1');
    expect(off.onPlan).not.toHaveBeenCalled();
  });

  it('clears the span with C, only while there is one', () => {
    const { onRangeClear } = render();
    press('c', { ctrlKey: true });
    expect(onRangeClear).not.toHaveBeenCalled();
    press('C');
    expect(onRangeClear).toHaveBeenCalledTimes(1);
    const off = render({ rangeClear: false });
    press('c');
    expect(off.onRangeClear).not.toHaveBeenCalled();
  });

  it('stops listening when unmounted', () => {
    const { onFrameTime } = render();
    act(() => root.render(null));
    press('ArrowLeft');
    expect(onFrameTime).not.toHaveBeenCalled();
  });
});

describe('useSensorSelection', () => {
  const points = [
    { pos: 1, device: 10, pair: 1 },
    { pos: 2, device: 10, pair: 2 },
    { pos: 3, device: 20, pair: 1 },
  ];
  type Selection = ReturnType<typeof useSensorSelection>;
  let current: Selection;
  const Harness = ({
    shownDevice,
    onDevice,
  }: {
    shownDevice: number;
    onDevice: (device: number) => void;
  }) => {
    current = useSensorSelection({
      points,
      shownDevice,
      deviceIds: [10, 20],
      onDevice,
    });
    return null;
  };
  const render = (shownDevice: number, onDevice = vi.fn()) => {
    act(() =>
      root.render(<Harness shownDevice={shownDevice} onDevice={onDevice} />),
    );
    return onDevice;
  };

  it('adds and focuses a sensor clicked on the plan', () => {
    render(10);
    act(() => current.selectPlanSensor(2));
    act(() => current.selectPlanSensor(1));
    expect(current.sensors).toEqual([0, 1]);
    expect(current.selectedPositions).toEqual([1, 2]);
    expect(current.focusedPosition).toBe(1);
  });

  it("shows another device's sensor alone", () => {
    const onDevice = render(10);
    act(() => current.selectPlanSensor(1));
    act(() => current.selectPlanSensor(3));
    expect(onDevice).toHaveBeenCalledWith(20);
    expect(current.sensors).toEqual([0]);
    render(20, onDevice);
    expect(current.selectedPositions).toEqual([3]);
    expect(current.focusedPosition).toBe(3);
  });

  it('selects a dragged area and focuses a single sensor added in the charts', () => {
    render(10);
    act(() => current.selectPlanArea([2, 1]));
    expect(current.sensors).toEqual([0, 1]);
    expect(current.focusedPosition).toBeNull();
    act(() => current.changeSensors([0]));
    act(() => current.changeSensors([0, 1]));
    expect(current.focusedPosition).toBe(2);
  });
});
