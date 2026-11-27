import { type ReactNode, useState } from 'react';
import { Form } from 'react-bootstrap';
import { Pencil, PlusLg, Trash } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../ui/kit/ConfirmDialog';
import { childTestId, repeatedTestId } from '../../testIds';
import './ConfigSectionCards.css';

/** The colours of the staff admin's permission groups (StaffAdmin.css). */
export type SectionTone = 'blue' | 'teal' | 'purple' | 'amber' | 'red' | 'cyan' | 'green' | 'grey';

export type SectionValues = Record<string, string | boolean>;

/** One input of a section's dialog; `key` is the value's name in the config. */
/** `label`: the translated name shown instead of `key`. */
/** `showWhen`: the key of a switch in the same dialog - the field shows (and counts) only while it is on. */
export type SectionField = { key: string; label?: string; testId?: string; showWhen?: string } & (
  | { kind: 'text' | 'password' }
  | { kind: 'number'; min?: number; max?: number }
  | { kind: 'select'; options: { value: string; label: string; title?: string }[] }
  | { kind: 'switch' }
);

export type ConfigSection = {
  /** The section's name in the config ("wifi", "router", ...). */
  name: string;
  /** The translated card name shown instead of `name`. */
  title?: string;
  tone: SectionTone;
  /** What the card shows: the config's values, in its order. */
  rows: { key: string; label?: string; value: ReactNode; testId?: string }[];
  /** More than values (QR codes). */
  body?: ReactNode;
  /** The inputs of its dialog - none: the card cannot be edited. */
  fields?: SectionField[];
  /** What the dialog starts from, by field key. */
  values?: SectionValues;
  onSave?: (values: SectionValues) => void;
  /** An optional section: its card can be removed. */
  onRemove?: () => void;
  /** Whether the dialog may save these values (beyond the number ranges). */
  valid?: (values: SectionValues) => boolean;
};

/** A secret as a card shows it. */
export const maskedSecret = (value: string) => (value ? '••••••' : '');

const numberValid = (field: SectionField, value: string | boolean) => {
  if (field.kind !== 'number') {
    return true;
  }
  const number = Number(value);
  return (
    String(value).trim() !== '' &&
    Number.isInteger(number) &&
    (field.min == null || number >= field.min) &&
    (field.max == null || number <= field.max)
  );
};

/**
 * The sections of a device config as cards: each shows the section's values,
 * its pencil opens a minimal dialog to change them. `addable` sections are
 * not in the config yet - a dashed tile adds them through the same dialog.
 */
const ConfigSectionCards = ({
  sections,
  addable = [],
  disabled = false,
  testId = 'config-sections',
}: {
  sections: ConfigSection[];
  addable?: ConfigSection[];
  disabled?: boolean;
  testId?: string;
}) => {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<SectionValues>({});

  const isNew = addable.some((section) => section.name === editing);
  const edited = [...sections, ...addable].find((section) => section.name === editing) ?? null;

  const open = (section: ConfigSection) => {
    setDraft({ ...section.values });
    setEditing(section.name);
  };

  const set = (key: string, value: string | boolean) => setDraft((current) => ({ ...current, [key]: value }));

  const visibleFields = (edited?.fields || []).filter((field) => !field.showWhen || draft[field.showWhen] === true);

  const draftValid =
    !!edited &&
    visibleFields.every((field) => numberValid(field, draft[field.key])) &&
    (edited.valid?.(draft) ?? true);

  const save = () => {
    if (!edited || !draftValid) {
      return;
    }
    edited.onSave?.(draft);
    setEditing(null);
  };

  const input = (field: SectionField, index: number) => {
    const id = `${testId}-${edited?.name}-${field.key}`;
    const fieldTestId = field.testId ?? childTestId(testId, 'field', field.key);
    if (field.kind === 'switch') {
      return (
        <Form.Check
          key={field.key}
          type="switch"
          id={id}
          label={field.label ?? field.key}
          checked={draft[field.key] === true}
          onChange={(event) => set(field.key, event.target.checked)}
          data-testid={fieldTestId}
        />
      );
    }
    return (
      <Form.Group key={field.key} controlId={id}>
        <Form.Label className="config-section-label mb-0">{field.label ?? field.key}</Form.Label>
        {field.kind === 'select' ? (
          <Form.Select
            size="sm"
            autoFocus={index === 0}
            value={String(draft[field.key] ?? '')}
            onChange={(event) => set(field.key, event.target.value)}
            data-testid={fieldTestId}
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value} title={option.title}>
                {option.label}
              </option>
            ))}
          </Form.Select>
        ) : (
          <Form.Control
            size="sm"
            autoFocus={index === 0}
            type={field.kind}
            autoComplete={field.kind === 'password' ? 'new-password' : 'off'}
            min={field.kind === 'number' ? field.min : undefined}
            max={field.kind === 'number' ? field.max : undefined}
            isInvalid={!numberValid(field, draft[field.key])}
            value={String(draft[field.key] ?? '')}
            onChange={(event) => set(field.key, event.target.value)}
            data-testid={fieldTestId}
          />
        )}
      </Form.Group>
    );
  };

  return (
    <>
      <div className="config-sections" data-testid={testId}>
        {sections.map((section) => (
          <section
            key={section.name}
            className={`config-section config-section--${section.tone}`}
            {...repeatedTestId(`${testId}-card`, section.name)}
          >
            <header className="config-section-head">
              <span className="config-section-name">{section.title ?? section.name}</span>
              {section.onRemove && (
                <button
                  type="button"
                  className="config-section-action"
                  onClick={section.onRemove}
                  disabled={disabled}
                  title={t('provision_section_remove', { section: section.title ?? section.name })}
                  aria-label={t('provision_section_remove', { section: section.title ?? section.name })}
                  {...repeatedTestId(`${testId}-remove`, section.name)}
                >
                  <Trash size={13} aria-hidden="true" />
                </button>
              )}
              {section.fields && section.fields.length > 0 && (
                <button
                  type="button"
                  className="config-section-action"
                  onClick={() => open(section)}
                  disabled={disabled}
                  title={t('provision_section_edit', { section: section.title ?? section.name })}
                  aria-label={t('provision_section_edit', { section: section.title ?? section.name })}
                  {...repeatedTestId(`${testId}-edit`, section.name)}
                >
                  <Pencil size={13} aria-hidden="true" />
                </button>
              )}
            </header>
            <dl className="config-section-rows">
              {section.rows.map((row) => (
                <div key={row.key} className="config-section-row">
                  <dt>{row.label ?? row.key}</dt>
                  <dd data-testid={row.testId}>{row.value === '' || row.value == null ? '–' : row.value}</dd>
                </div>
              ))}
            </dl>
            {section.body}
          </section>
        ))}
        {addable.map((section) => (
          <button
            key={section.name}
            type="button"
            className={`config-section config-section--add config-section--${section.tone}`}
            onClick={() => open(section)}
            disabled={disabled}
            {...repeatedTestId(`${testId}-add`, section.name)}
          >
            <PlusLg size={15} aria-hidden="true" />
            {t('provision_section_add', { section: section.title ?? section.name })}
          </button>
        ))}
      </div>

      <ConfirmDialog
        testId={`${testId}-dialog`}
        show={!!edited}
        danger={false}
        title={t(isNew ? 'provision_section_add' : 'provision_section_edit', { section: edited?.title ?? edited?.name })}
        confirmLabel={t('provision_section_save')}
        cancelLabel={t('provision_section_cancel')}
        confirmDisabled={!draftValid}
        onCancel={() => setEditing(null)}
        onConfirm={save}
        message={
          <Form
            className="config-section-form"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            {visibleFields.map(input)}
            {/* Enter saves. */}
            <button type="submit" hidden />
          </Form>
        }
      />
    </>
  );
};

export default ConfigSectionCards;
