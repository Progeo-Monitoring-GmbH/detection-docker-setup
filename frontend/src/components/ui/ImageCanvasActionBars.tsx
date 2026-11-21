/**
 * The floating action bars of ImageCanvasStage: applying a selection, the
 * point calibration (A), a group alignment (L) and storing the scale. Each
 * shows only while its action is going on.
 */
import { useTranslation } from 'react-i18next';
import { childTestId } from '../../testIds';
import FloatingActionBar from './kit/FloatingActionBar';
import { applyBarTexts, GROUP_COLOR, pointNounOf, pointSelectOf, type SelectMode } from './imageCanvasModes';

/** "Apply" / "Remove N" / "Cut N" / "Align N" for the selected area of `mode` (none without). */
export const ApplyBar = ({
  mode,
  selectedCount,
  lineMode,
  busy,
  onCancel,
  onApply,
  testId,
}: {
  mode: SelectMode | null;
  selectedCount: number;
  lineMode: boolean;
  busy: boolean;
  onCancel: () => void;
  onApply: () => void;
  testId: string;
}) => {
  const { t } = useTranslation();
  if (!mode) {
    return null;
  }
  const selectingPoints = pointSelectOf(mode) != null;
  const texts = applyBarTexts(mode, selectingPoints, selectedCount, lineMode, t);
  return (
    <FloatingActionBar
      tone={texts.tone}
      message={texts.message}
      detail={texts.detail}
      actions={[
        { label: 'Cancel', variant: 'secondary', disabled: busy, onClick: onCancel, testId: childTestId(testId, 'apply-cancel') },
        {
          label: texts.label,
          variant: texts.variant,
          color: texts.color,
          busy,
          disabled: selectingPoints && selectedCount === 0,
          onClick: onApply,
          testId: childTestId(testId, 'apply'),
        },
      ]}
      testId={childTestId(testId, 'apply-bar')}
    />
  );
};

/** The point calibration (A): Done keeps the alignment, Cancel restores the one before. */
export const AlignBar = ({
  aligning,
  pins,
  lineMode,
  onStop,
  testId,
}: {
  aligning: boolean;
  pins: number;
  lineMode: boolean;
  onStop: (restore: boolean) => void;
  testId: string;
}) =>
  aligning ? (
    <FloatingActionBar
      message={`Point calibration: ${pins} ${lineMode ? 'dm sensor(s)' : 'sensor(s)'} pinned`}
      detail="The alignment is stored as you pin - Done keeps it, Cancel restores the one before."
      actions={[
        { label: 'Cancel', variant: 'secondary', onClick: () => onStop(true), testId: childTestId(testId, 'align-cancel') },
        { label: 'Done', onClick: () => onStop(false), testId: childTestId(testId, 'align-done') },
      ]}
      testId={childTestId(testId, 'align-bar')}
    />
  ) : null;

/** A group alignment (L): Apply stores the points' new places. */
export const GroupBar = ({
  group,
  fits,
  lineMode,
  busy,
  onCancel,
  onApply,
  testId,
}: {
  group: { size: number; pins: number } | null;
  fits: boolean;
  lineMode: boolean;
  busy: boolean;
  onCancel: () => void;
  onApply: () => void;
  testId: string;
}) =>
  group ? (
    <FloatingActionBar
      message={`Align ${group.size} ${pointNounOf(lineMode)}(s) by themselves · ${group.pins} pinned`}
      detail={group.pins === 0 ? 'Drag one of them onto its place first.' : 'Apply stores their new places.'}
      actions={[
        { label: 'Cancel', variant: 'secondary', disabled: busy, onClick: onCancel, testId: childTestId(testId, 'group-cancel') },
        {
          label: 'Apply',
          color: GROUP_COLOR,
          busy,
          disabled: !fits || group.pins === 0,
          onClick: onApply,
          testId: childTestId(testId, 'group-apply'),
        },
      ]}
      testId={childTestId(testId, 'group-bar')}
    />
  ) : null;

/** The reference point or the ratio are not stored yet (dirty). */
export const ScaleBar = ({
  dirty,
  hasReference,
  metersPerPixel,
  onStore,
  testId,
}: {
  dirty: boolean;
  hasReference: boolean;
  metersPerPixel: number | null;
  onStore: () => void;
  testId: string;
}) =>
  dirty ? (
    <FloatingActionBar
      message="The scale is not stored yet"
      detail={[
        hasReference ? 'reference point set' : null,
        metersPerPixel ? `${Number(metersPerPixel.toPrecision(4))} m per pixel` : null,
      ]
        .filter(Boolean)
        .join(' · ')}
      actions={[{ label: 'Store scale', onClick: onStore, testId: childTestId(testId, 'scale-store') }]}
      testId={childTestId(testId, 'scale-bar')}
    />
  ) : null;
