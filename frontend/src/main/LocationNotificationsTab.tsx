import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Spinner,
  Table,
} from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import {
  showErrorBar,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';

type LocationNotificationsTabProps = {
  locationId: number;
};

type AccessRule = {
  id: number;
  location?: number | null;
  user?: number | null;
  user_name?: string | null;
  user_email?: string | null;
  transport?: number | null;
  type?: number | null;
};

type AccessUser = {
  id: number;
  username: string;
  email?: string | null;
  mobile?: string | null;
};

// ProgeoAccess.NotifiTrans / NotifiTypes bit values.
const TRANSPORT_OPTIONS = [
  { value: 0, label: 'Silent' },
  { value: 1, label: 'E-Mail' },
  { value: 2, label: 'SMS' },
  { value: 4, label: 'E-Mail + SMS' },
];
const TYPE_OPTIONS = [
  { value: 1, label: 'Alarm', variant: 'danger' },
  { value: 2, label: 'Timeout', variant: 'warning' },
  { value: 4, label: 'News', variant: 'info' },
];

const transportLabel = (value?: number | null) =>
  TRANSPORT_OPTIONS.find((option) => option.value === value)?.label ??
  `(${value ?? '?'})`;

const typeLabels = (value?: number | null) =>
  TYPE_OPTIONS.filter((option) => (value ?? 0) & option.value).map(
    (option) => option.label,
  );

/**
 * Benachrichtigungen tab: shows and edits the ProgeoAccess notification rules
 * of the location (who gets notified, via which transport, for which type).
 */
const LocationNotificationsTab = ({
  locationId,
}: LocationNotificationsTabProps) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { hasPermission } = usePermissions();

  // module_notifications_edit: change/delete rules + fix contact data;
  // module_notifications_add: create a rule for a new user.
  const canEdit = hasPermission('module_notifications_edit');
  const canAdd = hasPermission('module_notifications_add');
  const canManage = canEdit || canAdd;

  const [rules, setRules] = useState<AccessRule[]>([]);
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Form state (create / edit)
  const [editId, setEditId] = useState<number | null>(null);
  const [userId, setUserId] = useState<string>('');
  const [transport, setTransport] = useState<number>(0);
  const [typeBits, setTypeBits] = useState<number>(0);

  // Quick-fix contact data of the selected user (missing email / mobile).
  const [contactEdit, setContactEdit] = useState<{
    field: 'email' | 'mobile';
    value: string;
  } | null>(null);
  const [contactSaving, setContactSaving] = useState(false);

  const loadRules = useCallback(() => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/access/`,
      (response) => {
        setRules((response?.data?.access || []) as AccessRule[]);
        setUsers((response?.data?.users || []) as AccessUser[]);
        setLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not load access rules: ${reason}`);
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar, locationId]);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  const resetForm = useCallback(() => {
    setEditId(null);
    setUserId('');
    setTransport(0);
    setTypeBits(0);
  }, []);

  const startEdit = (rule: AccessRule) => {
    setEditId(rule.id);
    setUserId(String(rule.user ?? ''));
    setTransport(rule.transport ?? 0);
    setTypeBits(rule.type ?? 0);
  };

  const saveRule = () => {
    if (!userId && !editId) {
      showErrorBar(enqueueSnackbar, 'Select a user first.');
      return;
    }
    setSaving(true);
    const payload: Record<string, unknown> = {
      transport,
      type: typeBits,
    };
    if (editId) {
      payload.id = editId;
    } else {
      payload.user_id = Number(userId);
    }
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/access/`,
      payload,
      (response) => {
        const saved = (response?.data?.access || null) as AccessRule | null;
        if (saved) {
          setRules((prev) => {
            const exists = prev.some((rule) => rule.id === saved.id);
            return exists
              ? prev.map((rule) => (rule.id === saved.id ? saved : rule))
              : [...prev, saved];
          });
        }
        showSuccessBar(
          enqueueSnackbar,
          editId ? 'Access rule updated.' : 'Access rule created.',
        );
        resetForm();
        setSaving(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not save access rule: ${reason}`);
        setSaving(false);
      },
    );
  };

  const deleteRule = (rule: AccessRule) => {
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/access/delete/`,
      { id: rule.id },
      () => {
        setRules((prev) => prev.filter((item) => item.id !== rule.id));
        if (editId === rule.id) {
          resetForm();
        }
        showSuccessBar(enqueueSnackbar, 'Access rule deleted.');
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not delete access rule: ${reason}`);
      },
    );
  };

  const selectableUsers = useMemo(
    () => users.filter((user) => !rules.some((rule) => rule.user === user.id)),
    [users, rules],
  );

  /** The user the form currently applies to (create selection or edit rule). */
  const selectedUser = useMemo(() => {
    const id = Number(userId);
    return users.find((user) => user.id === id) ?? null;
  }, [users, userId]);

  const hasEmail = Boolean(selectedUser?.email?.trim());
  const hasMobile = Boolean(selectedUser?.mobile?.trim());

  /** E-Mail/SMS transports need the respective contact data of the user. */
  const transportAvailable = (value: number): boolean => {
    if (!selectedUser) {
      return false;
    }
    if (value === 1) {
      return hasEmail;
    }
    if (value === 2) {
      return hasMobile;
    }
    if (value === 4) {
      return hasEmail && hasMobile;
    }
    return true; // Silent is always fine
  };

  const transportHint = useMemo(() => {
    if (!selectedUser) {
      return 'Select a user first to see which transports are available.';
    }
    const missing: string[] = [];
    if (!hasEmail) {
      missing.push('E-Mail is not selectable: this user has no e-mail address.');
    }
    if (!hasMobile) {
      missing.push('SMS is not selectable: this user has no mobile number.');
    }
    return missing.join(' ');
  }, [selectedUser, hasEmail, hasMobile]);

  const saveContact = () => {
    if (!selectedUser || !contactEdit) {
      return;
    }
    setContactSaving(true);
    const payload: Record<string, unknown> = { user_id: selectedUser.id };
    payload[contactEdit.field] = contactEdit.value.trim();
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/access/user/`,
      payload,
      (response) => {
        const updated = (response?.data?.user || null) as AccessUser | null;
        if (updated) {
          setUsers((prev) =>
            prev.map((user) => (user.id === updated.id ? updated : user)),
          );
        }
        showSuccessBar(
          enqueueSnackbar,
          `${contactEdit.field === 'email' ? 'E-Mail' : 'Mobile number'} updated.`,
        );
        setContactEdit(null);
        setContactSaving(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not update contact data: ${reason}`);
        setContactSaving(false);
      },
    );
  };

  return (
    <Card className="border-0 shadow-sm p-2">
      <Card.Body>
        <h5 className="mb-3">Benachrichtigungen</h5>

        {loading ? (
          <div className="d-flex align-items-center gap-2 text-muted py-4">
            <Spinner size="sm" animation="border" /> Loading access rules...
          </div>
        ) : (
          <>
            <Table striped hover size="sm" responsive>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Transport</th>
                  <th>Type</th>
                  <th style={{ width: 170 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td>
                      {rule.user_name || `#${rule.user ?? '?'}`}
                      {rule.user_email ? (
                        <div className="small text-muted">{rule.user_email}</div>
                      ) : null}
                    </td>
                    <td>{transportLabel(rule.transport)}</td>
                    <td>
                      {typeLabels(rule.type).length > 0
                        ? typeLabels(rule.type).join(', ')
                        : 'Silent'}
                    </td>
                    <td>
                      {canEdit ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline-primary"
                            className="me-1"
                            onClick={() => startEdit(rule)}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="outline-danger"
                            onClick={() => deleteRule(rule)}
                          >
                            Delete
                          </Button>
                        </>
                      ) : (
                        <span className="small text-muted">view only</span>
                      )}
                    </td>
                  </tr>
                ))}
                {rules.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-muted">
                      No notification rules yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>

            <hr />

            {!canManage ? (
              <Alert variant="info" className="mb-0 small">
                Du kannst die Benachrichtigungsregeln nur ansehen. Zum Anlegen
                von Regeln fehlt dir die Berechtigung{' '}
                <code>module_notifications_add</code>, zum Ändern / Löschen und
                zum Pflegen der Kontaktdaten{' '}
                <code>module_notifications_edit</code>.
              </Alert>
            ) : !canAdd && !editId ? (
              <Alert variant="warning" className="mb-0 small">
                Du kannst bestehende Regeln bearbeiten, aber keine neuen
                anlegen (<code>module_notifications_add</code> fehlt).
              </Alert>
            ) : (
              <>
                <h6 className="mb-3">
                  {editId ? `Edit rule #${editId}` : 'Add notification rule'}
                </h6>
            <div className="d-flex flex-wrap align-items-end gap-3">
              <Form.Group style={{ minWidth: 200 }}>
                <Form.Label className="small text-muted">User</Form.Label>
                <Form.Select
                  size="sm"
                  value={userId}
                  disabled={!!editId}
                  onChange={(event) => {
                    setUserId(event.target.value);
                    setTransport(0);
                  }}
                >
                  <option value="">Select user…</option>
                  {(editId
                    ? users
                    : selectableUsers
                  ).map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.username}
                      {user.email ? ` (${user.email})` : ''}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>

              <Form.Group>
                <Form.Label className="small text-muted">Transport</Form.Label>
                <div className="d-flex gap-3">
                  {TRANSPORT_OPTIONS.map((option) => {
                    const available = transportAvailable(option.value);
                    const disabled = !selectedUser || !available;
                    const limitation =
                      option.value === 1
                        ? 'needs an e-mail address'
                        : option.value === 2
                          ? 'needs a mobile number'
                          : option.value === 4
                            ? 'needs e-mail AND mobile'
                            : '';
                    return (
                      <Form.Check
                        key={option.value}
                        type="radio"
                        name="access-transport"
                        label={option.label}
                        title={disabled ? limitation : undefined}
                        disabled={disabled}
                        checked={transport === option.value}
                        onChange={() => setTransport(option.value)}
                      />
                    );
                  })}
                </div>
                {selectedUser && transportHint && (
                  <div className="small text-warning mt-1" style={{ maxWidth: 420 }}>
                    {transportHint}
                  </div>
                )}
              </Form.Group>

              <Form.Group>
                <Form.Label className="small text-muted">Type</Form.Label>
                <div className="d-flex gap-3">
                  {TYPE_OPTIONS.map((option) => (
                    <Form.Check
                      key={option.value}
                      type="checkbox"
                      label={option.label}
                      checked={(typeBits & option.value) !== 0}
                      onChange={(event) =>
                        setTypeBits((prev) =>
                          event.target.checked
                            ? prev | option.value
                            : prev & ~option.value,
                        )
                      }
                    />
                  ))}
                </div>
              </Form.Group>

              <Button
                size="sm"
                variant="primary"
                onClick={saveRule}
                disabled={saving}
              >
                {saving ? 'Saving…' : editId ? 'Save changes' : 'Add rule'}
              </Button>
              {editId && (
                <Button size="sm" variant="outline-secondary" onClick={resetForm}>
                  Cancel
                </Button>
              )}
            </div>

            {/* Quick fix: add missing contact data of the selected user so the
                mail/SMS transports become available (edit permission). */}
            {canEdit && selectedUser && (contactEdit || !hasEmail || !hasMobile) && (
              <div className="mt-3 p-3 border rounded bg-light">
                <div className="small fw-semibold mb-2">
                  Contact data of {selectedUser.username}
                </div>
                <div className="d-flex flex-wrap align-items-end gap-3">
                  {hasEmail ? (
                    <div className="small text-muted">
                      E-Mail:{' '}
                      <span className="text-dark">{selectedUser.email}</span>
                    </div>
                  ) : contactEdit?.field === 'email' ? (
                    <>
                      <Form.Control
                        size="sm"
                        style={{ width: 220 }}
                        type="email"
                        placeholder="e-mail address"
                        value={contactEdit.value}
                        autoFocus
                        onChange={(event) =>
                          setContactEdit({
                            field: 'email',
                            value: event.target.value,
                          })
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            saveContact();
                          }
                        }}
                      />
                      <Button
                        size="sm"
                        variant="success"
                        onClick={saveContact}
                        disabled={contactSaving || !contactEdit.value.trim()}
                      >
                        {contactSaving ? 'Saving…' : 'Save e-mail'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline-secondary"
                        onClick={() => setContactEdit(null)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline-primary"
                      onClick={() => setContactEdit({ field: 'email', value: '' })}
                    >
                      + Add e-mail address
                    </Button>
                  )}

                  {hasMobile ? (
                    <div className="small text-muted">
                      Mobile:{' '}
                      <span className="text-dark">{selectedUser.mobile}</span>
                    </div>
                  ) : contactEdit?.field === 'mobile' ? (
                    <>
                      <Form.Control
                        size="sm"
                        style={{ width: 220 }}
                        placeholder="+49 …"
                        value={contactEdit.value}
                        autoFocus
                        onChange={(event) =>
                          setContactEdit({
                            field: 'mobile',
                            value: event.target.value,
                          })
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            saveContact();
                          }
                        }}
                      />
                      <Button
                        size="sm"
                        variant="success"
                        onClick={saveContact}
                        disabled={contactSaving || !contactEdit.value.trim()}
                      >
                        {contactSaving ? 'Saving…' : 'Save mobile'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline-secondary"
                        onClick={() => setContactEdit(null)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline-primary"
                      onClick={() => setContactEdit({ field: 'mobile', value: '' })}
                    >
                      + Add mobile number
                    </Button>
                  )}
                </div>
              </div>
            )}
              </>
            )}
          </>
        )}
      </Card.Body>
    </Card>
  );
};

export default LocationNotificationsTab;
