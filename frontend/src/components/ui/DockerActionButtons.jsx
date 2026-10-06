import React from 'react';
import { Button } from 'react-bootstrap';
import {
  Book,
  BootstrapReboot,
  PauseFill,
  TrashFill,
} from 'react-bootstrap-icons';
import { showErrorBar, showSuccessBar } from './Snackbar';
import { useSnackbar } from 'notistack';
import axiosConfig from '../../axiosConfig';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import { defaultErrorCallback } from '@/helper.jsx';

const DockerActionButtons = ({ modalState, setModalState, id, status }) => {
  const { enqueueSnackbar } = useSnackbar();
  const auth = useAuth();

  function restartDockerContainer(id) {
    axiosConfig.perform_post(
      auth,
      'api/docker/restart/',
      {
        container_id: id,
      },
      (response) => {
        if (response.data.success) {
          showSuccessBar(enqueueSnackbar, 'Successfully restarted');
        } else {
          showErrorBar(enqueueSnackbar, 'Restarting failed');
        }
      },
      defaultErrorCallback,
    );
  }

  function removeDockerContainer(id) {
    axiosConfig.perform_post(
      auth,
      'api/docker/remove/',
      {
        container_id: id,
      },
      (response) => {
        if (response.data.success) {
          showSuccessBar(enqueueSnackbar, 'Successfully removed');
        } else {
          showErrorBar(enqueueSnackbar, 'Removing failed');
        }
      },
      defaultErrorCallback,
    );
  }

  function stopDockerContainer(id) {
    axiosConfig.perform_post(
      auth,
      'api/docker/stop/',
      {
        container_id: id,
      },
      (response) => {
        if (response.data.success) {
          showSuccessBar(enqueueSnackbar, 'Successfully stopped');
        } else {
          showErrorBar(enqueueSnackbar, 'Stopping failed');
        }
      },
      defaultErrorCallback,
    );
  }

  function showLogs(id) {
    axiosConfig
      .perform_post('api/docker/logs/', {
        container_id: id,
      })
      .then((response) => {
        if (response.data.success) {
          setModalState({
            ...modalState,
            modalShowText: true,
            title: response.data.name,
            txt: response.data.logs,
          });
        } else {
          showErrorBar(enqueueSnackbar, 'Could not get logs!');
        }
      }, defaultErrorCallback);
  }

  return (
    <>
      <Button
        variant="danger"
        className={'me-1'}
        disabled={status === 'running'}
        onClick={() => removeDockerContainer(id)}
        title={'Delete Container'}
      >
        <TrashFill />
      </Button>
      <Button
        variant="info"
        className={'me-1'}
        disabled={status !== 'running'}
        onClick={() => {
          stopDockerContainer(id);
        }}
        title={'Stop Container'}
      >
        <PauseFill />
      </Button>
      <Button
        variant="info"
        className={'me-1'}
        onClick={() => {
          restartDockerContainer(id);
        }}
        title={'Restart Container'}
      >
        <BootstrapReboot />
      </Button>
      <Button
        variant="info"
        className={'me-1'}
        onClick={() => {
          showLogs(id);
        }}
        title={'See Logs'}
      >
        <Book />
      </Button>
    </>
  );
};

export default DockerActionButtons;
