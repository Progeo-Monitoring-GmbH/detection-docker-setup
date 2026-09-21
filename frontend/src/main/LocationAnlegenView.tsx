import { useEffect, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import LabeledInput from '../components/ui/kit/LabeledInput';

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
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not create object: ${reason}`);
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
          const reason = error?.response?.data?.reason || error.message;
          showErrorBar(enqueueSnackbar, `Could not import data: ${reason}`);
          setImporting(false);
        },
      );
    };
    reader.readAsText(file);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 900 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          background: 'var(--progeo-surface)',
          borderRadius: 14,
          padding: '13px 18px',
          fontSize: 13,
          color: '#6E6868',
        }}
      >
        {t('anlegen_notice')}
      </div>

      <PanelCard title={t('anlegen_section_stammdaten')}>
        <div style={{ fontSize: 12.5, color: '#8B8383', marginBottom: 14 }}>
          {t('anlegen_section_stammdaten_hint')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ fontSize: 11, letterSpacing: '.07em', textTransform: 'uppercase', color: '#8B8383', fontWeight: 500 }}>
              {t('anlegen_field_account')}
            </span>
            <select
              value={form.accountId}
              onChange={(event) => setField('accountId')(event.target.value)}
              style={{ height: 40, border: 'none', borderRadius: 11, background: 'var(--progeo-surface)', padding: '0 12px', fontFamily: 'inherit', fontSize: 14, color: 'var(--progeo-blue)' }}
            >
              <option value="">{t('anlegen_field_account_placeholder')}</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
          <LabeledInput label={t('anlegen_field_nr')} value={form.nr} onChange={setField('nr')} />
          <LabeledInput label={t('anlegen_field_name')} value={form.name} onChange={setField('name')} />
          <LabeledInput label={t('anlegen_field_airtable')} value={form.airtableUrl} onChange={setField('airtableUrl')} title={t('anlegen_field_airtable_hint')} />
        </div>
      </PanelCard>

      <PanelCard title={t('anlegen_section_adresse')}>
        <div style={{ fontSize: 12.5, color: '#8B8383', marginBottom: 14 }}>{t('anlegen_section_adresse_hint')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
          <LabeledInput label={t('anlegen_field_address')} value={form.address} onChange={setField('address')} />
          <LabeledInput label={t('anlegen_field_plz')} value={form.plz} onChange={setField('plz')} />
          <LabeledInput label={t('anlegen_field_city')} value={form.city} onChange={setField('city')} />
          <LabeledInput label={t('anlegen_field_country')} value={form.country} onChange={setField('country')} />
        </div>
      </PanelCard>

      <PanelCard title={t('anlegen_section_ansprechpartner')}>
        <div style={{ fontSize: 12.5, color: '#8B8383', marginBottom: 14 }}>{t('anlegen_section_ansprechpartner_hint')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
          <LabeledInput label={t('anlegen_field_manager')} value={form.manager} onChange={setField('manager')} />
          <LabeledInput label={t('anlegen_field_mail')} value={form.mail} onChange={setField('mail')} />
          <LabeledInput label={t('anlegen_field_telefon')} value={form.telefon} onChange={setField('telefon')} />
        </div>
      </PanelCard>

      <PanelCard title={t('anlegen_section_produkt')}>
        <div style={{ fontSize: 12.5, color: '#8B8383', marginBottom: 14 }}>{t('anlegen_section_produkt_hint')}</div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, maxWidth: 260 }}>
          <span style={{ fontSize: 11, letterSpacing: '.07em', textTransform: 'uppercase', color: '#8B8383', fontWeight: 500 }}>
            {t('anlegen_field_project_type')}
          </span>
          <select
            value={form.projectType}
            onChange={(event) => setField('projectType')(event.target.value)}
            style={{ height: 40, border: 'none', borderRadius: 11, background: 'var(--progeo-surface)', padding: '0 12px', fontFamily: 'inherit', fontSize: 14, color: 'var(--progeo-blue)' }}
          >
            {projectTypes.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </PanelCard>

      <PanelCard title={t('anlegen_section_files')}>
        <div style={{ fontSize: 12.5, color: '#8B8383', marginBottom: 14 }}>{t('anlegen_section_files_hint')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
          <div style={{ background: 'var(--progeo-surface)', borderRadius: 13, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13.5, fontWeight: 500 }}>{t('anlegen_field_visualization')}</div>
            <div style={{ fontSize: 12, color: '#8B8383' }}>{t('anlegen_field_visualization_hint')}</div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 9, height: 36, padding: '0 15px', borderRadius: 10, background: 'var(--progeo-track-soft)', color: 'var(--progeo-blue)', fontSize: 13, fontWeight: 500, cursor: 'pointer', alignSelf: 'flex-start' }}>
              <span>{t('anlegen_choose_files')}</span>
              <input
                type="file"
                multiple
                onChange={(event) => setVisualizationFiles(Array.from(event.target.files || []))}
                style={{ display: 'none' }}
              />
            </label>
            {visualizationFiles.map((file) => (
              <div key={file.name} style={{ fontSize: 12.5 }}>{file.name}</div>
            ))}
          </div>
          <div style={{ background: 'var(--progeo-surface)', borderRadius: 13, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13.5, fontWeight: 500 }}>{t('anlegen_field_coordinates')}</div>
            <div style={{ fontSize: 12, color: '#8B8383' }}>{t('anlegen_field_coordinates_hint')}</div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 9, height: 36, padding: '0 15px', borderRadius: 10, background: 'var(--progeo-track-soft)', color: 'var(--progeo-blue)', fontSize: 13, fontWeight: 500, cursor: 'pointer', alignSelf: 'flex-start' }}>
              <span>{t('anlegen_choose_files')}</span>
              <input
                type="file"
                multiple
                onChange={(event) => setCoordinateFiles(Array.from(event.target.files || []))}
                style={{ display: 'none' }}
              />
            </label>
            {coordinateFiles.map((file) => (
              <div key={file.name} style={{ fontSize: 12.5 }}>{file.name}</div>
            ))}
          </div>
        </div>
      </PanelCard>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <PillButton label={t('anlegen_create')} onClick={create} disabled={creating} />
        <label
          style={{
            height: 40,
            padding: '0 16px',
            borderRadius: 10,
            background: 'var(--progeo-surface)',
            color: 'var(--progeo-blue)',
            fontSize: 13.5,
            fontWeight: 500,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 9,
          }}
        >
          <span>{importing ? '…' : t('anlegen_import_data')}</span>
          <input
            type="file"
            accept="application/json"
            onChange={(event) => importData(event.target.files)}
            style={{ display: 'none' }}
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
        />
        {importMsg && <span style={{ fontSize: 12.5, color: '#3F7A1C', fontWeight: 500 }}>{importMsg}</span>}
      </div>
    </div>
  );
};

export default LocationAnlegenView;
