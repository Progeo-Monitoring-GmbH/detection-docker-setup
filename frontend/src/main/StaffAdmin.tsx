import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Container,
  Form,
  Modal,
  Spinner,
} from 'react-bootstrap';
import {
  ArrowRepeat,
  Key,
  PencilSquare,
  PersonPlus,
  ShieldLock,
  Trash,
} from 'react-bootstrap-icons';
import DataTable from 'react-data-table-component';
import type { TableColumn } from 'react-data-table-component';
import { useSnackbar } from 'notistack';

import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import {
  showErrorBar,
  showInfoBar,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';

type PermissionDef = {
  code: string;
  label: string;
};

type StaffUser = {
  id: number;
  username: string;
  email: string;
  is_staff: boolean;
  is_superuser: boolean;
  is_active: boolean;
  date_joined?: string | null;
  last_login?: string | null;
  permissions: Record<string, boolean>;
  grantable: Record<string, boolean>;
};

type UsersResponse = {
  users: StaffUser[];
  grantable_codes: string[];
  all_permission_defs: PermissionDef[];
};

const EMPTY_RESPONSE: UsersResponse = {
  users: [],
  grantable_codes: [],
  all_permission_defs: [],
};

/** Compact human-readable label for a permission code. */
const permissionLabel = (code: string): string => {
  const cleaned = code
    .replace(/^module_/, '')
    .replace(/_enabled$/, '')
    .replace(/_/g, ' ')
    .trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
};

const rowPermissions = (user: StaffUser): string[] =>
  Object.keys(user.permissions || {}).filter((code) => user.permissions[code]);

const UserFormModal = ({
  show,
  onHide,
  title,
  user,
  grantableCodes,
  permissionDefs,
  isNew,
  onSave,
  onGeneratePassword,
}: {
  show: boolean;
  onHide: () => void;
  title: string;
  user: StaffUser | null;
  grantableCodes: string[];
  permissionDefs: PermissionDef[];
  isNew: boolean;
  onSave: (data: Record<string, unknown>) => void;
  onGeneratePassword?: (user: StaffUser) => void;
}) => {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isStaff, setIsStaff] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [selectedPerms, setSelectedPerms] = useState<string[]>([]);

  useEffect(() => {
    if (!show) {
      return;
    }
    setUsername(user?.username || '');
    setEmail(user?.email || '');
    setPassword('');
    setIsStaff(Boolean(user?.is_staff));
    setIsActive(user ? Boolean(user.is_active) : true);
    setSelectedPerms(rowPermissions(user || ({} as StaffUser)));
  }, [show, user]);

  const togglePermission = (code: string) => {
    setSelectedPerms((current) =>
      current.includes(code)
        ? current.filter((item) => item !== code)
        : [...current, code],
    );
  };

  const handleSubmit = () => {
    const payload: Record<string, unknown> = {
      email,
      is_staff: isStaff,
      is_active: isActive,
      permissions: selectedPerms,
    };
    if (isNew) {
      payload.username = username;
      if (password) {
        payload.password = password;
      }
    }
    onSave(payload);
  };

  return (
    <Modal show={show} onHide={onHide} centered size="lg">
      <Modal.Header closeButton>
        <Modal.Title>{title}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Form>
          {isNew && (
            <Form.Group className="mb-3">
              <Form.Label>Username</Form.Label>
              <Form.Control
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="login name"
              />
            </Form.Group>
          )}
          <Form.Group className="mb-3">
            <Form.Label>Email address</Form.Label>
            <Form.Control
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="user@example.com"
            />
          </Form.Group>
          {isNew && (
            <Form.Group className="mb-3">
              <Form.Label>Initial password</Form.Label>
              <Form.Control
                type="text"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="leave empty to generate one"
              />
            </Form.Group>
          )}

          <div className="d-flex gap-4 mb-3">
            <Form.Check
              type="switch"
              id="staff-switch"
              label="Staff member"
              checked={isStaff}
              onChange={(event) => setIsStaff(event.target.checked)}
            />
            <Form.Check
              type="switch"
              id="active-switch"
              label="Active"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
            />
          </div>

          <Form.Label className="d-block">
            Permissions{' '}
            <small className="text-muted">
              (only permissions you have yourself can be granted)
            </small>
          </Form.Label>
          <div
            className="border rounded p-2 mb-2"
            style={{ maxHeight: 220, overflowY: 'auto' }}
          >
            {permissionDefs.length === 0 && (
              <small className="text-muted">No permissions available.</small>
            )}
            {permissionDefs.map((def) => {
              const grantable = grantableCodes.includes(def.code);
              return (
                <Form.Check
                  key={def.code}
                  type="switch"
                  id={`perm-${def.code}`}
                  label={`${def.label} (${def.code})`}
                  disabled={!grantable}
                  checked={selectedPerms.includes(def.code)}
                  onChange={() => togglePermission(def.code)}
                />
              );
            })}
          </div>
          {grantableCodes.length === 0 && (
            <small className="text-muted">
              You have no grantable permissions yourself.
            </small>
          )}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        {!isNew && onGeneratePassword && user && (
          <Button
            variant="outline-warning"
            onClick={() => onGeneratePassword(user)}
          >
            <Key className="me-1" />
            Generate password
          </Button>
        )}
        <Button variant="secondary" onClick={onHide}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSubmit}>
          Save
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

const PasswordResultModal = ({
  show,
  onHide,
  username,
  password,
}: {
  show: boolean;
  onHide: () => void;
  username: string;
  password: string;
}) => (
  <Modal show={show} onHide={onHide} centered>
    <Modal.Header closeButton>
      <Modal.Title>Generated password</Modal.Title>
    </Modal.Header>
    <Modal.Body>
      <p>
        New password for <strong>{username}</strong> (shown only once):
      </p>
      <Form.Control
        readOnly
        value={password}
        onFocus={(event) => event.target.select()}
      />
    </Modal.Body>
    <Modal.Footer>
      <Button variant="primary" onClick={onHide}>
        Close
      </Button>
    </Modal.Footer>
  </Modal>
);

const StaffAdmin = () => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();

  const [response, setResponse] = useState<UsersResponse>(EMPTY_RESPONSE);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [editUser, setEditUser] = useState<StaffUser | null>(null);
  const [passwordResult, setPasswordResult] = useState<{
    username: string;
    password: string;
  } | null>(null);

  const isStaff = Boolean(
    (auth?.user as { is_staff?: boolean } | null)?.is_staff,
  );

  const fetchUsers = useCallback(() => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      '/api/auth-support/staff/users/',
      (result) => {
        setResponse((result?.data || EMPTY_RESPONSE) as UsersResponse);
        setLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not load users: ${reason}`);
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar]);

  useEffect(() => {
    if (isStaff) {
      fetchUsers();
    } else {
      setLoading(false);
    }
  }, [isStaff, fetchUsers]);

  const handleSave =
    (user: StaffUser | null, isNew: boolean) =>
    (data: Record<string, unknown>) => {
      setBusyId(isNew ? -1 : (user?.id ?? -1));
      const url = isNew
        ? '/api/auth-support/staff/users/'
        : `/api/auth-support/staff/users/${user!.id}/update/`;
      void axiosConfig.perform_post(
        auth,
        url,
        data,
        (result) => {
          const denied = (result?.data?.denied_permissions || []) as string[];
          const generated = (result?.data?.generated_password || null) as
            string | null;
          if (denied.length > 0) {
            showInfoBar(
              enqueueSnackbar,
              `Denied permissions (not held by you): ${denied.join(', ')}`,
            );
          }
          if (generated) {
            setPasswordResult({
              username: (result?.data?.user?.username as string) || '',
              password: generated,
            });
          }
          showSuccessBar(
            enqueueSnackbar,
            isNew ? 'User created.' : 'User updated.',
          );
          setShowCreate(false);
          setEditUser(null);
          setBusyId(null);
          fetchUsers();
        },
        (error) => {
          const reason = error?.response?.data?.reason || error.message;
          showErrorBar(
            enqueueSnackbar,
            `${isNew ? 'Could not create user' : 'Could not update user'}: ${reason}`,
          );
          setBusyId(null);
        },
      );
    };

  const handleGeneratePassword = (user: StaffUser) => {
    setBusyId(user.id);
    void axiosConfig.perform_post(
      auth,
      `/api/auth-support/staff/users/${user.id}/password/`,
      {},
      (result) => {
        setPasswordResult({
          username: result?.data?.username || user.username,
          password: result?.data?.new_password || '',
        });
        setBusyId(null);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not reset password: ${reason}`);
        setBusyId(null);
      },
    );
  };

  const handleDelete = (user: StaffUser) => {
    if (
      !window.confirm(`Delete user "${user.username}"? This cannot be undone.`)
    ) {
      return;
    }
    setBusyId(user.id);
    void axiosConfig.perform_post(
      auth,
      `/api/auth-support/staff/users/${user.id}/delete/`,
      {},
      (result) => {
        showSuccessBar(
          enqueueSnackbar,
          `User "${result?.data?.deleted || user.username}" deleted.`,
        );
        setBusyId(null);
        fetchUsers();
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not delete user: ${reason}`);
        setBusyId(null);
      },
    );
  };

  const columns = useMemo<TableColumn<StaffUser>[]>(
    () => [
      {
        name: 'Username',
        selector: (row) => row.username,
        sortable: true,
        cell: (row) => (
          <span>
            {row.username}
            {row.is_superuser && (
              <ShieldLock className="ms-2 text-warning" size={14} />
            )}
          </span>
        ),
      },
      {
        name: 'Email',
        selector: (row) => row.email || '-',
        sortable: true,
      },
      {
        name: 'Staff',
        cell: (row) =>
          row.is_staff ? (
            <Badge bg="warning" text="dark">
              staff
            </Badge>
          ) : (
            <Badge bg="secondary">user</Badge>
          ),
        width: '80px',
      },
      {
        name: 'Active',
        cell: (row) =>
          row.is_active ? (
            <Badge bg="success">active</Badge>
          ) : (
            <Badge bg="danger">inactive</Badge>
          ),
        width: '90px',
      },
      {
        name: 'Permissions',
        cell: (row) => {
          const enabled = rowPermissions(row);
          if (enabled.length === 0) {
            return <span className="text-muted small">none</span>;
          }
          return (
            <span className="d-flex flex-wrap gap-1">
              {enabled.slice(0, 3).map((code) => (
                <Badge key={code} bg="info" pill text="dark">
                  {permissionLabel(code)}
                </Badge>
              ))}
              {enabled.length > 3 && (
                <Badge bg="secondary" pill>
                  +{enabled.length - 3}
                </Badge>
              )}
            </span>
          );
        },
      },
      {
        name: 'Actions',
        width: '180px',
        cell: (row) => (
          <span className="d-flex gap-1">
            <Button
              size="sm"
              variant="outline-primary"
              title="Edit user"
              disabled={busyId === row.id}
              onClick={() => setEditUser(row)}
            >
              <PencilSquare size={14} />
            </Button>
            <Button
              size="sm"
              variant="outline-warning"
              title="Generate new password"
              disabled={busyId === row.id}
              onClick={() => handleGeneratePassword(row)}
            >
              <Key size={14} />
            </Button>
            <Button
              size="sm"
              variant="outline-danger"
              title="Delete user"
              disabled={busyId === row.id}
              onClick={() => handleDelete(row)}
            >
              <Trash size={14} />
            </Button>
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busyId],
  );

  if (!isStaff) {
    return (
      <Container>
        <Card className="border-0 shadow-sm my-5">
          <Card.Body className="text-center py-5">
            <ShieldLock size={40} className="text-muted mb-3" />
            <h5>Staff access required</h5>
            <p className="text-muted mb-0">
              You need a staff account to manage users.
            </p>
          </Card.Body>
        </Card>
      </Container>
    );
  }

  return (
    <Container fluid>
      <Card className="border-0 shadow-sm my-4 p-3">
        <Card.Body>
          <div className="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
            <h5 className="mb-0">
              <ShieldLock className="me-2 text-warning" />
              Staff Admin
            </h5>
            <div className="d-flex gap-2">
              <Button
                variant="outline-secondary"
                size="sm"
                onClick={fetchUsers}
              >
                <ArrowRepeat className="me-1" />
                Refresh
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowCreate(true)}
              >
                <PersonPlus className="me-1" />
                Add user
              </Button>
            </div>
          </div>

          <DataTable
            columns={columns}
            data={response.users}
            pagination
            paginationPerPage={15}
            paginationRowsPerPageOptions={[10, 15, 25, 50]}
            progressPending={loading}
            progressComponent={
              <div className="d-flex align-items-center gap-2 text-muted py-4">
                <Spinner size="sm" animation="border" />
                Loading users...
              </div>
            }
            highlightOnHover
            pointerOnHover
            dense
          />
        </Card.Body>
      </Card>

      <UserFormModal
        show={showCreate}
        onHide={() => setShowCreate(false)}
        title="Add user"
        user={null}
        isNew
        grantableCodes={response.grantable_codes}
        permissionDefs={response.all_permission_defs}
        onSave={handleSave(null, true)}
      />

      <UserFormModal
        show={editUser != null}
        onHide={() => setEditUser(null)}
        title={`Edit user: ${editUser?.username || ''}`}
        user={editUser}
        isNew={false}
        grantableCodes={response.grantable_codes}
        permissionDefs={response.all_permission_defs}
        onSave={handleSave(editUser, false)}
        onGeneratePassword={handleGeneratePassword}
      />

      <PasswordResultModal
        show={passwordResult != null}
        onHide={() => setPasswordResult(null)}
        username={passwordResult?.username || ''}
        password={passwordResult?.password || ''}
      />
    </Container>
  );
};

export default StaffAdmin;
