import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import LabeledInput from '../components/ui/kit/LabeledInput';
import PhoneInput from '../components/ui/PhoneInput';
import { childTestId, repeatedTestId } from '../testIds';
import { readJsonFile } from '../readJsonFile';
import { useLatestRef } from '../components/ui/useLatestRef';
import './LocationAnlegenView.css';

type AccountOption = { id: number; name: string };

/** Answer of GET /v1/location/nr-check/ (LocationViewSet.nr_check). */
type NrCheck = {
  nr: number | null;
  free: boolean | null;
  used_by: Array<{ id: number; name: string | null; account: string | null }> | null;
  suggestion: number;
};

/** What the Objekt-Nr. field shows below itself. */
type NrHint =
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'checking' }
  | { kind: 'free' }
  | { kind: 'used'; usedBy: NonNullable<NrCheck['used_by']> };

/** "123" -> 123, "" -> null, anything else -> NaN (invalid). */
export const parseNr = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
};

/**
 * The rows of an import file ({"data": [...]} as the export writes it, or a
 * plain array) and how many of each model ("ProgeoLocation: 1, ProgeoDevice: 4") -
 * told in the confirmation before anything is sent.
 */
export const importSummary = (payload: unknown): { rows: number; summary: string } => {
  const rows =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as { data?: unknown }).data : payload;
  if (!Array.isArray(rows)) {
    return { rows: 0, summary: '' };
  }
  const perModel = new Map<string, number>();
  for (const row of rows) {
    const clazz = row && typeof row === 'object' ? (row as { clazz?: unknown }).clazz : null;
    const name = typeof clazz === 'string' && clazz ? clazz : '?';
    perModel.set(name, (perModel.get(name) ?? 0) + 1);
  }
  return {
    rows: rows.length,
    summary: [...perModel].map(([name, count]) => `${name}: ${count}`).join(', '),
  };
};

/** Wait this long after the last keystroke before asking the backend. */
const NR_CHECK_DELAY_MS = 350;
type ProjectTypeOption = { value: number; label: string };

type FormState = {
  accountId: string;
  nr: string;
  name: string;
  airtableUrl: string;
  address: string;
  plz: string;
  city: string;
  country: string;
  manager: string;
  mail: string;
  telefon: string;
  projectType: string;
};

const EMPTY_FORM: FormState = {
  accountId: '',
  nr: '',
  name: '',
  airtableUrl: '',
  address: '',
  plz: '',
  city: '',
  country: '',
  manager: '',
  mail: '',
  telefon: '',
  projectType: '0',
};

/**
 * Anlegen (Objekt anlegen): creates a new ProgeoLocation under a chosen
 * existing Account. Staff-only, backed by LocationViewSet.create_object.
 * "Daten importieren" reuses the existing generic import feature
 * (/v1/data/import/) instead of a second import mechanism.
 */
type FilePickerCardProps = {
  title: string;
  hint: string;
  chooseLabel: string;
  files: File[];
  onChange: (files: File[]) => void;
  /** data-testid of the card; its input is "<testId>-input", the picked files "<testId>-file" (key: the name). */
  testId: string;
};

const FilePickerCard = ({ title, hint, chooseLabel, files, onChange, testId }: FilePickerCardProps) => (
  <div className="anlegen-file-card" data-testid={testId}>
    <div className="anlegen-file-card-title">{title}</div>
    <div className="anlegen-file-card-hint">{hint}</div>
    <label className="anlegen-file-choose">
      <span>{chooseLabel}</span>
      <input
        type="file"
        multiple
        onChange={(event) => onChange(Array.from(event.target.files || []))}
        className="anlegen-file-input"
        data-testid={childTestId(testId, 'input')}
      />
    </label>
    {files.map((file) => (
      <div key={file.name} className="anlegen-file-name" {...repeatedTestId(`${testId}-file`, file.name)}>{file.name}</div>
    ))}
  </div>
);

/** Below the Objekt-Nr.: free / already used (with links) / next free number. */
const NrHintLine = ({
  hint,
  suggestion,
  onUseSuggestion,
}: {
  hint: NrHint;
  suggestion: number | null;
  onUseSuggestion: (nr: number) => void;
}) => {
  const { t } = useTranslation();
  if (hint.kind === 'checking') {
    return (
      <div className="anlegen-nr-hint" data-testid="anlegen-nr-hint" data-state="checking">
        {t('anlegen_nr_checking')}
      </div>
    );
  }
  if (hint.kind === 'invalid') {
    return (
      <div className="anlegen-nr-hint anlegen-nr-hint--bad" data-testid="anlegen-nr-hint" data-state="invalid">
        {t('anlegen_nr_invalid')}
      </div>
    );
  }
  if (hint.kind === 'free') {
    return (
      <div className="anlegen-nr-hint anlegen-nr-hint--ok" data-testid="anlegen-nr-hint" data-state="free">
        {t('anlegen_nr_free')}
      </div>
    );
  }
  if (hint.kind === 'used') {
    return (
      <div className="anlegen-nr-hint anlegen-nr-hint--bad" data-testid="anlegen-nr-hint" data-state="used">
        {t('anlegen_nr_used')}{' '}
        {hint.usedBy.map((location, index) => (
          <span key={location.id}>
            {index > 0 && ', '}
            <Link to={`/location/${location.id}/object`} target="_blank" rel="noopener noreferrer">
              {location.name || `#${location.id}`}
            </Link>
            {location.account ? ` (${location.account})` : ''}
          </span>
        ))}
        {suggestion != null && (
          <>
            {' · '}
            <button type="button" className="anlegen-nr-suggestion" onClick={() => onUseSuggestion(suggestion)}>
              {t('anlegen_nr_use_suggestion', { nr: suggestion })}
            </button>
          </>
        )}
      </div>
    );
  }
  return suggestion != null ? (
    <div className="anlegen-nr-hint" data-testid="anlegen-nr-hint" data-state="empty">
      <button type="button" className="anlegen-nr-suggestion" onClick={() => onUseSuggestion(suggestion)}>
        {t('anlegen_nr_use_suggestion', { nr: suggestion })}
      </button>
    </div>
  ) : null;
};

const LocationAnlegenView = () => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();

  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [projectTypes, setProjectTypes] = useState<ProjectTypeOption[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [visualizationFiles, setVisualizationFiles] = useState<File[]>([]);
  const [coordinateFiles, setCoordinateFiles] = useState<File[]>([]);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  // A read import file waiting for the confirmation (its rows counted per model).
  const [pendingImport, setPendingImport] = useState<{ file: string; payload: unknown; summary: string; rows: number } | null>(null);
  const [nrHint, setNrHint] = useState<NrHint>({ kind: 'empty' });
  const [nrSuggestion, setNrSuggestion] = useState<number | null>(null);

  const authRef = useLatestRef(auth);

  // Is the Objekt-Nr. still free? Asked while typing (debounced); an
  // answer for an older value is dropped.
  useEffect(() => {
    const nr = parseNr(form.nr);
    if (nr === null) {
      setNrHint({ kind: 'empty' });
      return undefined;
    }
    if (Number.isNaN(nr)) {
      setNrHint({ kind: 'invalid' });
      return undefined;
    }
    let current = true;
    setNrHint({ kind: 'checking' });
    const timer = setTimeout(() => {
      void axiosConfig.perform_get(
        authRef.current,
        `/v1/location/nr-check/?nr=${nr}`,
        (response) => {
          if (!current) {
            return;
          }
          const check = response?.data as NrCheck | undefined;
          setNrSuggestion(check?.suggestion ?? null);
          setNrHint(check?.free === false ? { kind: 'used', usedBy: check.used_by ?? [] } : { kind: 'free' });
        },
        () => {
          // No hint rather than a wrong one - creating still works.
          if (current) {
            setNrHint({ kind: 'empty' });
          }
        },
      );
    }, NR_CHECK_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [form.nr, authRef]);

  useEffect(() => {
    void axiosConfig.perform_get(auth, '/v1/location/accounts/', (response) => {
      setAccounts((response?.data?.accounts || []) as AccountOption[]);
    });
    void axiosConfig.perform_get(auth, '/v1/location/project-types/', (response) => {
      setProjectTypes((response?.data?.project_types || []) as ProjectTypeOption[]);
    });
    // The next free number, offered while the field is empty.
    void axiosConfig.perform_get(auth, '/v1/location/nr-check/', (response) => {
      setNrSuggestion((response?.data?.suggestion as number | undefined) ?? null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setField = (field: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const create = () => {
    if (!form.accountId) {
      showErrorBar(enqueueSnackbar, t('anlegen_account_required'));
      return;
    }
    if (!form.name.trim()) {
      showErrorBar(enqueueSnackbar, t('anlegen_name_required'));
      return;
    }
    if (nrHint.kind === 'invalid') {
      showErrorBar(enqueueSnackbar, t('anlegen_nr_invalid'));
      return;
    }

    const body = new FormData();
    body.append('account_id', form.accountId);
    body.append('nr', form.nr);
    body.append('name', form.name);
    body.append('airtable_url', form.airtableUrl);
    body.append('address', form.address);
    body.append('plz', form.plz);
    body.append('city', form.city);
    body.append('country', form.country);
    body.append('manager', form.manager);
    body.append('mail', form.mail);
    body.append('telefon', form.telefon);
    body.append('project_type', form.projectType);
    visualizationFiles.forEach((file) => body.append('visualization_files', file));
    coordinateFiles.forEach((file) => body.append('coordinate_files', file));

    setCreating(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/location/create_object/',
      body,
      (response) => {
        const location = response?.data?.location;
        showSuccessBar(
          enqueueSnackbar,
          t('anlegen_created', { nr: location?.project_id ?? form.nr, name: location?.name ?? form.name }),
        );
        setForm(EMPTY_FORM);
        setVisualizationFiles([]);
        setCoordinateFiles([]);
        setCreating(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not create object', error);
        setCreating(false);
      },
    );
  };

  /** Reads the picked file and counts its rows - sent only after the confirmation. */
  const readImport = (files: FileList | null) => {
    if (files?.length) {
      setImportMsg(null);
    }
    readJsonFile(
      files,
      (payload, file) => {
        const { rows, summary } = importSummary(payload);
        setPendingImport({ file, payload, rows, summary });
      },
      () => showErrorBar(enqueueSnackbar, 'File is not valid JSON'),
    );
  };

  const importData = () => {
    if (!pendingImport) {
      return;
    }
    const { payload } = pendingImport;
    setPendingImport(null);
    setImporting(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/data/import/',
      payload,
      (response) => {
        const created = response?.data?.created ?? 0;
        const updated = response?.data?.updated ?? 0;
        setImportMsg(t('anlegen_import_done', { created, updated }));
        setImporting(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not import data', error);
        setImporting(false);
      },
    );
  };

  const optionalLabel = `(${t('access_optional')})`;

  return (
    <div className="anlegen-view" data-testid="page-anlegen">
      <div className="anlegen-notice" data-testid="anlegen-notice">
        {t('anlegen_notice')}
      </div>

      <PanelCard title={t('anlegen_section_stammdaten')} testId="anlegen-stammdaten">
        <div className="anlegen-section-hint">
          {t('anlegen_section_stammdaten_hint')}
        </div>
        <div className="anlegen-grid">
          <label className="anlegen-field">
            <span className="anlegen-field-label">
              {t('anlegen_field_account')}
              <span className="anlegen-field-required" aria-hidden="true"> *</span>
            </span>
            <select
              value={form.accountId}
              onChange={(event) => setField('accountId')(event.target.value)}
              className="anlegen-select"
              data-testid="anlegen-account"
            >
              <option value="">{t('anlegen_field_account_placeholder')}</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
          <div className="anlegen-nr">
            <LabeledInput
              label={t('anlegen_field_nr')}
              labelSuffix={optionalLabel}
              value={form.nr}
              onChange={setField('nr')}
              testId="anlegen-nr"
            />
            <NrHintLine
              hint={nrHint}
              suggestion={nrSuggestion}
              onUseSuggestion={(nr) => setField('nr')(String(nr))}
            />
          </div>
          <LabeledInput label={`${t('anlegen_field_name')} *`} value={form.name} onChange={setField('name')} testId="anlegen-name" />
          <LabeledInput label={t('anlegen_field_airtable')} labelSuffix={optionalLabel} value={form.airtableUrl} onChange={setField('airtableUrl')} testId="anlegen-airtable" title={t('anlegen_field_airtable_hint')} />
        </div>
      </PanelCard>

      <PanelCard title={t('anlegen_section_adresse')} testId="anlegen-adresse">
        <div className="anlegen-section-hint">{t('anlegen_section_adresse_hint')}</div>
        <div className="anlegen-grid">
          <LabeledInput label={t('anlegen_field_address')} labelSuffix={optionalLabel} value={form.address} onChange={setField('address')} testId="anlegen-address" />
          <LabeledInput label={t('anlegen_field_plz')} labelSuffix={optionalLabel} value={form.plz} onChange={setField('plz')} testId="anlegen-plz" />
          <LabeledInput label={t('anlegen_field_city')} labelSuffix={optionalLabel} value={form.city} onChange={setField('city')} testId="anlegen-city" />
          <LabeledInput label={t('anlegen_field_country')} labelSuffix={optionalLabel} value={form.country} onChange={setField('country')} testId="anlegen-country" />
        </div>
      </PanelCard>

      <PanelCard title={t('anlegen_section_ansprechpartner')} testId="anlegen-ansprechpartner">
        <div className="anlegen-section-hint">{t('anlegen_section_ansprechpartner_hint')}</div>
        <div className="anlegen-grid">
          <LabeledInput label={t('anlegen_field_manager')} labelSuffix={optionalLabel} value={form.manager} onChange={setField('manager')} testId="anlegen-manager" />
          <LabeledInput label={t('anlegen_field_mail')} labelSuffix={optionalLabel} value={form.mail} onChange={setField('mail')} testId="anlegen-mail" />
          <PhoneInput label={t('anlegen_field_telefon')} labelSuffix={optionalLabel} value={form.telefon} onChange={setField('telefon')} testId="anlegen-telefon" />
        </div>
      </PanelCard>

      <PanelCard title={t('anlegen_section_produkt')} testId="anlegen-produkt">
        <div className="anlegen-section-hint">{t('anlegen_section_produkt_hint')}</div>
        <label className="anlegen-field anlegen-field--narrow">
          <span className="anlegen-field-label">
            {t('anlegen_field_project_type')}
            <span className="anlegen-field-optional"> {optionalLabel}</span>
          </span>
          <select
            value={form.projectType}
            onChange={(event) => setField('projectType')(event.target.value)}
            className="anlegen-select"
            data-testid="anlegen-project-type"
          >
            {projectTypes.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </PanelCard>

      <PanelCard title={t('anlegen_section_files')} testId="anlegen-files">
        <div className="anlegen-section-hint">
          {t('anlegen_section_files_hint')} <span className="anlegen-field-optional">{optionalLabel}</span>
        </div>
        <div className="anlegen-grid anlegen-grid--files">
          <FilePickerCard
            title={t('anlegen_field_visualization')}
            hint={t('anlegen_field_visualization_hint')}
            chooseLabel={t('anlegen_choose_files')}
            files={visualizationFiles}
            onChange={setVisualizationFiles}
            testId="anlegen-visualization-files"
          />
          <FilePickerCard
            title={t('anlegen_field_coordinates')}
            hint={t('anlegen_field_coordinates_hint')}
            chooseLabel={t('anlegen_choose_files')}
            files={coordinateFiles}
            onChange={setCoordinateFiles}
            testId="anlegen-coordinate-files"
          />
        </div>
      </PanelCard>

      <div className="anlegen-actions" data-testid="anlegen-actions">
        <PillButton label={t('anlegen_create')} onClick={create} disabled={creating} testId="anlegen-create" />
        <span className="anlegen-required-note">{t('anlegen_required_note')}</span>
        <label className="anlegen-import" data-testid="anlegen-import">
          <span>{importing ? '…' : t('anlegen_import_data')}</span>
          <input
            type="file"
            accept="application/json"
            onChange={(event) => {
              readImport(event.target.files);
              event.target.value = '';
            }}
            className="anlegen-file-input"
            data-testid="anlegen-import-input"
          />
        </label>
        <PillButton
          variant="ghost"
          label={t('anlegen_reset')}
          onClick={() => {
            setForm(EMPTY_FORM);
            setVisualizationFiles([]);
            setCoordinateFiles([]);
          }}
          testId="anlegen-reset"
        />
        {importMsg && <span className="anlegen-import-msg" data-testid="anlegen-import-message">{importMsg}</span>}
      </div>
      <ConfirmDialog
        show={pendingImport !== null}
        title={t('anlegen_import_data')}
        message={t('anlegen_import_confirm', {
          file: pendingImport?.file ?? '',
          count: pendingImport?.rows ?? 0,
          summary: pendingImport?.summary || '-',
        })}
        confirmLabel={t('anlegen_import_data')}
        cancelLabel={t('anlegen_import_cancel')}
        onConfirm={importData}
        onCancel={() => setPendingImport(null)}
        testId="anlegen-import-dialog"
      />
    </div>
  );
};

export default LocationAnlegenView;
