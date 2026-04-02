import React, { useEffect, useState } from 'react';
import { Button, Col, Row } from 'react-bootstrap';
import { showSuccessBar } from '../components/ui/Snackbar';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import BoxContainer from '../components/ui/BoxContainer';
import CorePaginator from '../components/ui/CorePaginator';
import BackupButton from '../components/ui/BackupButton';
import { useParams } from 'react-router';
import axiosConfig from '../axiosConfig';
import { defaultErrorCallback, standardFetchData } from '../helper';
import { useAuth } from '../../hooks/CoreAuthProvider';
import LoadAble from '../components/ui/LoadAble.jsx';

const BackupView = () => {
  const auth = useAuth();
  const { account } = useParams();
  const { t, i18n } = useTranslation();
  const [data, setData] = useState({});
  const { enqueueSnackbar } = useSnackbar();
  const [urls, setUrls] = useState({
    backup: `/v1/${account}/backup/?page=1`,
  });

  useEffect(() => {
    if ('backup' in urls) {
      fetchBackups();
    }
  }, [urls]);

  function fetchBackups() {
    standardFetchData(auth, urls.backup, setData);
  }

  async function reloadBackup() {
    await axiosConfig.perform_post(
      auth,
      `/v1/${account}/backup/reload/`,
      {},
      (response) => {
        setData(response.data);
        showSuccessBar(enqueueSnackbar, 'Successfully reloaded Backups!');
      },
      defaultErrorCallback,
    );
  }

  async function createBackup() {
    await axiosConfig.perform_post(
      auth,
      `/v1/${account}/backup/create/`,
      {},
      (response) => {
        setData(response.data);
        showSuccessBar(enqueueSnackbar, 'Successfully created Backup!');
      },
      defaultErrorCallback,
    );
  }

  async function deleteAllBackups() {
    await axiosConfig.perform_post(
      auth,
      `/v1/${account}/backup/deleteAll/`,
      {},
      (response) => {
        setData(response.data);
        showSuccessBar(enqueueSnackbar, 'Successfully deleted all Backups!');
      },
      defaultErrorCallback,
    );
  }

  async function deleteBackup(id) {
    await axiosConfig.perform_post(
      auth,
      `/v1/${account}/backup/${id}/delete/`,
      {},
      (response) => {
        setData(response.data);
        showSuccessBar(enqueueSnackbar, 'Successfully deleted Backup!');
      },
      defaultErrorCallback,
    );
  }

  async function restoreBackup(id, name) {
    await axiosConfig.perform_post(
      auth,
      `/v1/${account}/backup/${id}/restore/`,
      {},
      (response) => {
        setData(response.data);
        showSuccessBar(enqueueSnackbar, `Successfully restored "${name}"!`);
      },
      defaultErrorCallback,
    );
  }

  const handlePaginator = ({ selected }) => {
    setUrls({
      ...urls,
      backup: `/v1/${account}/backup/?page=${selected + 1}`,
    });
  };

  return (
    <>
      <BoxContainer title={t('backup_actions')}>
        <Row>
          <Col>
            <Button
              className={'btn-lg me-3'}
              variant={'info'}
              onClick={() => reloadBackup()}
            >
              {t('backup_reload')}
            </Button>
            <Button
              className={'btn-lg me-3'}
              variant={'success'}
              onClick={() => createBackup()}
            >
              {t('backup_create')}
            </Button>
            <Button
              className={'btn-lg'}
              variant={'danger'}
              onClick={() => deleteAllBackups()}
            >
              {t('backup_delete_all')}
            </Button>
          </Col>
        </Row>
      </BoxContainer>

      <BoxContainer title={t('backup_available')}>
        <LoadAble loaded={data}>
          {'elements' in data && (
            <>
              {data.pages > 1 && (
                <Row>
                  <CorePaginator
                    pages={data.pages}
                    handleChange={handlePaginator}
                  />
                </Row>
              )}
              {data.elements.map((backup) => {
                return (
                  <BackupButton
                    {...backup}
                    callbackRestore={restoreBackup}
                    callbackDelete={deleteBackup}
                    key={backup.id}
                  />
                );
              })}
            </>
          )}
        </LoadAble>
      </BoxContainer>
    </>
  );
};

export default BackupView;
