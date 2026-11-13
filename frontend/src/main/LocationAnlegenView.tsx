import { useEffect, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import LabeledInput from '../components/ui/kit/LabeledInput';
import { childTestId, repeatedTestId } from '../testIds';
import './LocationAnlegenView.css';

type AccountOption = { id: number; name: string };
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

  useEffect(() => {
    void axiosConfig.perform_get(auth, '/v1/location/accounts/', (response) => {
      setAccounts((response?.data?.accounts || []) as AccountOption[]);
    });
    void axiosConfig.perform_get(auth, '/v1/location/project-types/', (response) => {
      setProjectTypes((response?.data?.project_types || []) as ProjectTypeOption[]);
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

  const importData = (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    setImporting(true);
    setImportMsg(null);
    const file = files[0];
    const reader = new FileReader();
    reader.onload = () => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(reader.result));
      } catch {
        showErrorBar(enqueueSnackbar, 'File is not valid JSON');
        setImporting(false);
        return;
      }
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
    reader.readAsText(file);
  };

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
          <LabeledInput label={t('anlegen_field_nr')} value={form.nr} onChange={setField('nr')} testId="anlegen-nr" />
          <LabeledInput label={t('anlegen_field_name')} value={form.name} onChange={setField('name')} testId="anlegen-name" />
          <LabeledInput label={t('anlegen_field_airtable')} value={form.airtableUrl} onChange={setField('airtableUrl')} testId="anlegen-airtable" title={t('anlegen_field_airtable_hint')} />
        </div>
      </PanelCard>

      <PanelCard title={t('anlegen_section_adresse')} testId="anlegen-adresse">
        <div className="anlegen-section-hint">{t('anlegen_section_adresse_hint')}</div>
        <div className="anlegen-grid">
          <LabeledInput label={t('anlegen_field_address')} value={form.address} onChange={setField('address')} testId="anlegen-address" />
          <LabeledInput label={t('anlegen_field_plz')} value={form.plz} onChange={setField('plz')} testId="anlegen-plz" />
          <LabeledInput label={t('anlegen_field_city')} value={form.city} onChange={setField('city')} testId="anlegen-city" />
          <LabeledInput label={t('anlegen_field_country')} value={form.country} onChange={setField('country')} testId="anlegen-country" />
        </div>
      </PanelCard>

      <PanelCard title={t('anlegen_section_ansprechpartner')} testId="anlegen-ansprechpartner">
        <div className="anlegen-section-hint">{t('anlegen_section_ansprechpartner_hint')}</div>
        <div className="anlegen-grid">
          <LabeledInput label={t('anlegen_field_manager')} value={form.manager} onChange={setField('manager')} testId="anlegen-manager" />
          <LabeledInput label={t('anlegen_field_mail')} value={form.mail} onChange={setField('mail')} testId="anlegen-mail" />
          <LabeledInput label={t('anlegen_field_telefon')} value={form.telefon} onChange={setField('telefon')} testId="anlegen-telefon" />
        </div>
      </PanelCard>

      <PanelCard title={t('anlegen_section_produkt')} testId="anlegen-produkt">
        <div className="anlegen-section-hint">{t('anlegen_section_produkt_hint')}</div>
        <label className="anlegen-field anlegen-field--narrow">
          <span className="anlegen-field-label">
            {t('anlegen_field_project_type')}
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
        <div className="anlegen-section-hint">{t('anlegen_section_files_hint')}</div>
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
        <label className="anlegen-import">
          <span>{importing ? '…' : t('anlegen_import_data')}</span>
          <input
            type="file"
            accept="application/json"
            onChange={(event) => importData(event.target.files)}
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
    </div>
  );
};

export default LocationAnlegenView;
