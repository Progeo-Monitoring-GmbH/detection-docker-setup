import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import { downloadResponse, openResponseInNewTab } from '../helper';

/**
 * The Analyse page's exports: the measurements as CSV (staff also raw) in a
 * new tab, the report as PDF - with a note once started / done.
 */
const useAnalyseExports = (
  locationId: number,
  projectId: number | null | undefined,
) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);

  const openCsv = (query: string) => {
    void openResponseInNewTab(
      auth,
      `/v1/location/${locationId}/export_csv/${query}`,
    );
    setExportMsg(t('analyse_export_csv_done'));
  };

  const exportPdf = () => {
    setExportingPdf(true);
    void downloadResponse(
      auth,
      `/v1/location/${locationId}/export_pdf/`,
      `${projectId ?? locationId}-report.pdf`,
    ).then((ok) => {
      setExportingPdf(false);
      if (ok) {
        setExportMsg(t('analyse_export_pdf_done'));
      }
    });
  };

  return {
    exportMsg,
    exportingPdf,
    exportCsv: () => openCsv(''),
    exportRawCsv: () => openCsv('?raw=1'),
    exportPdf,
  };
};

export default useAnalyseExports;
