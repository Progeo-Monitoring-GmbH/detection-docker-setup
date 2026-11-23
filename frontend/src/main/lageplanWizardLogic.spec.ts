import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBackendUrl } from '../backendUrl';
import {
  answerPoints,
  bandCount,
  belongsToPlan,
  canvasTitle,
  deviceRangesPayload,
  imageEditedMessage,
  importPayloadFor,
  jsonImportMessage,
  keptCutPoints,
  locationSearch,
  manualSensorsPayload,
  measurePointsData,
  mergedPoints,
  nextSelectedPlanId,
  nextUnplacedDeviceId,
  planSourceMeta,
  plansWithUpload,
  pointsById,
  pointSourceFor,
  pointsTiedTo,
  removedPointIds,
  requestedPlanId,
  rotatedSensors,
  rotationOf,
  scaleSavedMessage,
  sensorsTiedTo,
  swappedPlans,
  withCutPoints,
  withPlacedSensor,
} from './lageplanWizardLogic';
import type { WizardLageplan, WizardSensor } from './lageplanWizardUtils';

const plan = (id: number, extra: Partial<WizardLageplan> = {}) =>
  ({ id, ...extra }) as WizardLageplan;
const sensor = (
  deviceId: number,
  extra: Partial<WizardSensor> = {},
): WizardSensor => ({
  deviceId,
  label: `#${deviceId}`,
  nx: 0.25,
  ny: 0.5,
  lageplanId: null,
  ...extra,
});

describe('planSourceMeta', () => {
  // The image URL needs a backend URL: without VITE_BACKEND_URL (CI, no
  // .env.local) it falls back to window.location - and this spec runs in node.
  beforeEach(() => {
    vi.stubEnv('VITE_BACKEND_URL', 'https://backend.test');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is null without a plan image', () => {
    expect(planSourceMeta(null)).toBeNull();
    expect(planSourceMeta(plan(1))).toBeNull();
  });

  it('fills the defaults - vertically flipped unless the plan says otherwise', () => {
    expect(planSourceMeta(plan(1, { url: '/media/plans/halle.png' }))).toEqual({
      fileName: 'halle.png',
      imageUrl: getBackendUrl('/media/plans/halle.png'),
      offset_x: 0,
      offset_y: 0,
      scale_x: 1,
      scale_y: 1,
      flip_x: false,
      flip_y: true,
      reference_x: null,
      reference_y: null,
      meters_per_pixel: null,
    });
  });

  it("keeps the plan's own values", () => {
    const meta = planSourceMeta(
      plan(2, {
        url: '/a.png',
        name: 'EG',
        offset_x: 3,
        scale_y: 2,
        flip_y: false,
        meters_per_pixel: 0.01,
      }),
    );
    expect(meta).toMatchObject({
      fileName: 'EG',
      offset_x: 3,
      scale_y: 2,
      flip_y: false,
      meters_per_pixel: 0.01,
    });
  });
});

describe('belongsToPlan', () => {
  const ids = new Set([1, 2]);
  it('puts a point on its own plan', () => {
    expect(belongsToPlan(2, 2, ids, 1)).toBe(true);
    expect(belongsToPlan('2', 1, ids, 1)).toBe(false);
  });
  it('puts points without (a known) plan on the main plan', () => {
    expect(belongsToPlan(null, 1, ids, 1)).toBe(true);
    expect(belongsToPlan(99, 1, ids, 1)).toBe(true);
    expect(belongsToPlan(undefined, 2, ids, 1)).toBe(false);
    // No plans at all: no plan picked is the main plan.
    expect(belongsToPlan(null, null, new Set(), null)).toBe(true);
  });
});

describe('measurePointsData', () => {
  it('takes the lists, missing ones empty', () => {
    expect(measurePointsData(undefined)).toEqual({
      points: [],
      devices: [],
      plans: [],
    });
    expect(
      measurePointsData({
        points: [{ id: 1 }],
        devices: [{ id: 3 }],
        lageplans: null,
      }),
    ).toEqual({ points: [{ id: 1 }], devices: [{ id: 3 }], plans: [] });
  });
});

describe('nextSelectedPlanId', () => {
  const plans = [plan(1), plan(2), plan(3)];
  it('prefers the requested plan, then the picked one, then the main one', () => {
    expect(nextSelectedPlanId(plans, 3, 2)).toBe(3);
    expect(nextSelectedPlanId(plans, 9, 2)).toBe(2);
    expect(nextSelectedPlanId(plans, null, 9)).toBe(1);
    expect(nextSelectedPlanId([], 1, 1)).toBeNull();
  });
});

describe('points by id', () => {
  it('keeps only cut points still stored - in their stored version', () => {
    expect(
      keptCutPoints(
        [{ id: 1, nx: 0 }, { id: 5 }],
        [{ id: '1', nx: 1 }, { id: 2 }],
      ),
    ).toEqual([{ id: '1', nx: 1 }]);
  });

  it('reads the answer points and merges them by id', () => {
    expect(answerPoints({ points: 'nope' })).toEqual([]);
    expect(answerPoints(undefined)).toEqual([]);
    const moved = answerPoints({ points: [{ id: '2', nx: 9 }] });
    expect(
      mergedPoints([{ id: 1 }, { id: 2, nx: 0 }], pointsById(moved)),
    ).toEqual([{ id: 1 }, { id: '2', nx: 9 }]);
  });

  it('collects the removed ids', () => {
    expect(removedPointIds({ point_ids: ['1', 2] })).toEqual(new Set([1, 2]));
    expect(removedPointIds({}).size).toBe(0);
  });

  it('cuts a point out only once', () => {
    expect(
      withCutPoints([{ id: 1, a: 1 }, { id: 2 }], [{ id: '1', a: 2 }]),
    ).toEqual([{ id: 2 }, { id: '1', a: 2 }]);
  });
});

describe('rotation', () => {
  it('reads the direction', () => {
    expect(rotationOf({ direction: 'cw' })).toEqual({ clockwise: true });
    expect(rotationOf({ direction: 'ccw' })).toEqual({ clockwise: false });
    expect(rotationOf({ message: 'Lageplan cropped.' })).toBeNull();
    expect(rotationOf(undefined)).toBeNull();
  });

  it('turns only the sensors on the plan', () => {
    const sensors = [
      sensor(1, { lageplanId: 4 }),
      sensor(2, { lageplanId: 5 }),
    ];
    const turned = rotatedSensors(
      sensors,
      (s) => s.lageplanId === 4,
      false,
      true,
    );
    // Clockwise without flip: (nx, ny) -> (1 - ny, nx).
    expect(turned[0]).toMatchObject({ nx: 0.5, ny: 0.25 });
    expect(turned[1]).toBe(sensors[1]);
  });
});

describe('messages', () => {
  it('names the image edit', () => {
    expect(imageEditedMessage({ message: 'Lageplan cropped.' })).toBe(
      'Lageplan cropped and saved - the sensors kept their place.',
    );
    expect(imageEditedMessage({})).toBe('Area cleared and saved.');
  });

  it('counts a JSON import when the answer lists it', () => {
    expect(jsonImportMessage({ data: [1, 2] })).toBe(
      '2 measure point(s) imported and saved.',
    );
    expect(jsonImportMessage(undefined)).toBe(
      'Measure points imported and saved.',
    );
  });

  it('names the stored scale', () => {
    expect(scaleSavedMessage(0.0123456)).toBe(
      'Scale saved (0.01235 m per pixel).',
    );
    expect(scaleSavedMessage(undefined)).toBe('Reference point saved.');
  });

  it('titles the canvas by what it shows', () => {
    const counts = { sensorCount: 2, pointCount: 7 };
    expect(canvasTitle({ manual: true, lines: true, ...counts })).toBe(
      '2 sensor(s) placed on this plan',
    );
    expect(canvasTitle({ manual: false, lines: true, ...counts })).toBe(
      '7 dm sensor(s) on this plan',
    );
    expect(canvasTitle({ manual: false, lines: false, ...counts })).toBe(
      '7 measure point(s) on this plan',
    );
  });
});

describe('plans', () => {
  it('puts an upload first, once', () => {
    expect(
      plansWithUpload([plan(1), plan(2)], plan(2, { name: 'new' })).map(
        (p) => p.id,
      ),
    ).toEqual([2, 1]);
  });

  it('swaps a plan with its neighbour - null out of range', () => {
    const plans = [plan(1), plan(2), plan(3)];
    expect(swappedPlans(plans, 1, -1)?.map((p) => p.id)).toEqual([2, 1, 3]);
    expect(swappedPlans(plans, 1, 1)?.map((p) => p.id)).toEqual([1, 3, 2]);
    expect(swappedPlans(plans, 0, -1)).toBeNull();
    expect(swappedPlans(plans, 2, 1)).toBeNull();
    expect(plans.map((p) => p.id)).toEqual([1, 2, 3]);
  });

  it('ties points and sensors without a plan to the old main plan', () => {
    expect(pointsTiedTo([{ id: 1 }, { id: 2, lageplan: 5 }], 3)).toEqual([
      { id: 1, lageplan: 3 },
      { id: 2, lageplan: 5 },
    ]);
    expect(
      sensorsTiedTo([sensor(1), sensor(2, { lageplanId: 5 })], 3).map(
        (s) => s.lageplanId,
      ),
    ).toEqual([3, 5]);
  });
});

describe('deviceRangesPayload', () => {
  it('saves the used ranges of step 2 as a list - an empty start is 1', () => {
    expect(
      deviceRangesPayload(7, [
        { deviceId: 1, from: ' ', to: '8 ' },
        { deviceId: null, from: '1', to: '' },
        { deviceId: 2, from: '9', to: '' },
      ]),
    ).toEqual({
      location_id: 7,
      point_devices: [
        { device_id: 1, from: 1, to: '8' },
        { device_id: 2, from: '9', to: '' },
      ],
    });
  });
});

describe('importPayloadFor', () => {
  it('sends the used ranges - an empty start is 1', () => {
    expect(
      importPayloadFor(7, 3, [
        { deviceId: 1, from: ' ', to: '8 ' },
        { deviceId: null, from: '1', to: '' },
        { deviceId: 2, from: '9', to: '' },
      ]),
    ).toEqual({
      location_id: 7,
      lageplan_id: 3,
      point_devices: JSON.stringify([
        { device_id: 1, from: 1, to: '8' },
        { device_id: 2, from: '9', to: '' },
      ]),
    });
  });

  it('leaves the plan out without one', () => {
    expect(importPayloadFor(7, null, [])).toEqual({
      location_id: 7,
      point_devices: '[]',
    });
  });
});

describe('manual placement', () => {
  it('places a sensor - replacing its earlier place', () => {
    const placed = sensor(2, { nx: 0.9 });
    expect(
      withPlacedSensor([sensor(1)], placed).map((s) => s.deviceId),
    ).toEqual([1, 2]);
    expect(withPlacedSensor([sensor(2), sensor(1)], placed)[0]).toBe(placed);
  });

  it('continues with the next device without a point', () => {
    const devices = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(nextUnplacedDeviceId(devices, 1, new Set([2]))).toBe(3);
    expect(nextUnplacedDeviceId(devices, 1, new Set([2, 3]))).toBeNull();
  });

  it('stores rounded positions, keeping the plan of a sensor without one', () => {
    expect(
      manualSensorsPayload([
        sensor(4, { nx: 0.1234567, ny: 0.5, lageplanId: 2 }),
        sensor(5),
      ]),
    ).toEqual([
      { x: 0.123457, y: 0.5, device_id: 4, lageplan_id: 2 },
      { x: 0.25, y: 0.5, device_id: 5, lageplan_id: undefined },
    ]);
  });
});

describe('locationSearch', () => {
  it('names the location and drops ?plan=', () => {
    expect(locationSearch('?location=3&plan=2&x=1', 7)).toBe('?location=7&x=1');
    expect(locationSearch('?location=7&plan=2', 7)).toBe('?location=7');
  });
  it('is null when nothing changes', () => {
    expect(locationSearch('?location=7', 7)).toBeNull();
    expect(locationSearch('', null)).toBeNull();
  });
  it('drops the location on reset', () => {
    expect(locationSearch('?location=7', null)).toBe('');
  });
});

describe('bandCount', () => {
  it('counts points with a band end', () => {
    expect(bandCount([{ nx_end: 1, ny_end: 0 }, { nx_end: 1 }, {}])).toBe(1);
  });
});

describe('location start', () => {
  const location = (project_type: number | null) => ({
    id: 7,
    project_id: 7078,
    name: 'Halle 7',
    project_type,
  });
  it('sets the points of a LoRaWAN project by hand, others by CAD', () => {
    expect(pointSourceFor(location(6))).toBe('manual');
    expect(pointSourceFor(location(1))).toBe('cad');
    expect(pointSourceFor(null)).toBe('cad');
  });
  it('reads ?plan=', () => {
    expect(requestedPlanId(new URLSearchParams('?location=7&plan=3'))).toBe(3);
    expect(requestedPlanId(new URLSearchParams('?plan=x'))).toBeNull();
    expect(requestedPlanId(new URLSearchParams(''))).toBeNull();
  });
});
