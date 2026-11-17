// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BadgePicker from './BadgePicker';
import { projectNumbersIn, type ProjectChoice } from '../../../main/StaffAccessRequests';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECTS: ProjectChoice[] = [
  { project_id: 4711, names: ['Halle Nord'] },
  { project_id: 4712, names: ['Lager'] },
  { project_id: 9000, names: ['Werk'] },
];

let container: HTMLDivElement;
let root: Root;
let picked: ProjectChoice[] = [];

const Harness = () => {
  const [selected, setSelected] = useState<ProjectChoice[]>([]);
  useEffect(() => {
    picked = selected;
  }, [selected]);
  return (
    <BadgePicker<ProjectChoice>
      selected={selected}
      onChange={setSelected}
      keyOf={(project) => project.project_id}
      badgeLabel={(project) => String(project.project_id)}
      optionLabel={(project) => `${project.project_id} ${project.names?.[0] ?? ''}`}
      search={(text) => PROJECTS.filter((project) => `${project.project_id} ${project.names}`.includes(text))}
      fromText={projectNumbersIn}
      delay={0}
      testId="picker"
    />
  );
};

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const input = () => container.querySelector<HTMLInputElement>('[data-testid="picker-input"]')!;

const type = async (text: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    vi.runAllTimers();
  });
};

const key = (name: string) =>
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });

const options = () =>
  Array.from(container.querySelectorAll('[data-testid="picker-option"]')).map((node) => node.getAttribute('data-test-key'));

describe('BadgePicker', () => {
  it('lists the matches of the text and adds the clicked one as a badge', async () => {
    await type('471');
    expect(options()).toEqual(['4711', '4712']);

    act(() => {
      container
        .querySelector('[data-testid="picker-option"][data-test-key="4712"]')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(picked.map((project) => project.project_id)).toEqual([4712]);
    expect(container.querySelector('[data-testid="picker-badge"][data-test-key="4712"]')).not.toBeNull();
    expect(input().value).toBe('');
  });

  it('takes typed numbers on Enter, leaves picked ones out of the list and removes a badge on its x', async () => {
    await type('9000, 4711');
    key('Enter');
    expect(picked.map((project) => project.project_id)).toEqual([9000, 4711]);

    await type('471');
    expect(options()).toEqual(['4712']);

    act(() => {
      (container.querySelector('[data-testid="picker-remove"][data-test-key="9000"]') as HTMLElement).click();
    });
    expect(picked.map((project) => project.project_id)).toEqual([4711]);
  });

  it('removes the last badge with Backspace in the empty field', async () => {
    await type('4711');
    key('Enter');
    key('Backspace');
    expect(picked).toEqual([]);
  });
});

describe('projectNumbersIn', () => {
  it('finds project numbers in free text - once each, three digits at least', () => {
    expect(projectNumbersIn('Projekt 4711 und 4712; auch 4711, Haus 12').map((project) => project.project_id)).toEqual([
      4711, 4712,
    ]);
    expect(projectNumbersIn('')).toEqual([]);
  });
});
