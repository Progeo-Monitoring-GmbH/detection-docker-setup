# Object access, invitations and object data

## Who may see an object

- **Account member:** sees every object of the account (`Account.users`). Today all customer objects are in one account, so membership is handed out by staff only in exceptional cases. "Alle Objekte des Kontos" in the Rechte tab means: all objects of the account the object belongs to. Assigning a customer an account of their own is not built yet.
- **Single access:** a `ProgeoAccess` row for one object. It is also the person's notification rule for that object.
- **ProGeo staff** (`is_staff` or `is_superuser`): see every object. Customers never see staff in user lists. Staff see them, marked "ProGeo-Team".

**Object lists** (`/v1/location/min/`, the location pickers and the overview, `location_access.listed_locations`) are narrower than what may be opened:

- **Superusers** list every object of every account.
- **Staff** list the objects of the accounts they are a member of, plus the objects granted to them one by one. Being staff alone lists nothing, although staff can still open any object by its link.
- **Everyone else** lists the objects of their accounts plus their single accesses.

**Customer admins** (`module_customer_admin_enabled`, no staff flag) manage the users of their own account(s) on `/staff/` (the users table only). They create users in their account, change the permissions of its customers, and grant only the permissions they hold themselves. They never grant `module_customer_admin_enabled`; only staff grant that, and permissions a customer admin can't grant stay untouched when they save a user.

Code: [progeo/helper/location_access.py](../progeo/helper/location_access.py).

## Roles in the Rechte tab

| Role | How it is defined | Rechte tab |
| --- | --- | --- |
| ProGeo staff / superadmin | `is_staff` or `is_superuser` | everything, also staff notifications |
| Kundenadmin | `module_locations_edit` (+ `module_notifications_add` to add people) | add people by email, change notifications |
| Kundennutzer | neither | own entry only, can't add anyone |

The backend enforces this: `POST /v1/location/<id>/access/invite/` and `access/account-member/` refuse users without `module_locations_edit` (403), and `GET …/access/` answers `can_invite`.

## Adding people by email (`access/invite`)

There is no user picker any more. It listed every user sharing the requester's account, and with all objects in one account that was every customer. A customer admin enters an email address (optionally a name) and the scope:

- **Address has an account:** access is granted at once, and the person gets the mail `location_access` ("you now have access to …"). The admin sees "User already exists, we sent them a notification".
- **New address:** a user without a password and with the default customer permissions is created and gets access. The invitation `location_invite` goes out with a one-time sign-in link (`MAGIC_LINK_INVITE_HOURS`, default 72 h). The person then sets a password in the profile.
- **Already has access:** nothing changes.
- **ProGeo staff address:** nothing changes (staff see everything).

Single access gets alarm notifications by email; that can be changed in the list right away. Scope "account" is offered only to staff and members of the object's account.

The answer tells the admin whether an address has an account. The concept asks for this. Only customer admins of the object get that far, every lookup grants access and mails the address owner, and `ACCESS_INVITES_PER_HOUR` (default 20, per inviting customer) caps it.

Code: [progeo/helper/location_invites.py](../progeo/helper/location_invites.py). Tests: [test_location_invites.py](../progeo/tests/test_location_invites.py).

### Why the list can be empty

The list shows account members and single-access users of the object. Customers of the old platform get their single access from the user import (`python manage.py import_users users.csv`, see [migration_invites.md](migration_invites.md)). Until it has run, objects have no customer users, so the list is empty.

## Demo users per role

`python manage.py demo_role_users` creates or refreshes two users on the demo account (run `demo_account` first):

| Username | Role |
| --- | --- |
| `demo-kundenadmin` | Kundenadmin (sees "Nutzer hinzufügen" and the edit controls) |
| `demo-kundennutzer` | Kundennutzer (view-only) |

They sign in on `/login` with the password the command prints. New users get a random password; re-runs keep it (`--reset-passwords` prints new ones, `--disable` deactivates them). They are read-only like the public `demo` user: they hold the demo permission, so `DemoReadOnlyMiddleware` refuses every write and they only see demo data. A shared password can't change anything or send invitations. Their addresses are `<username>@progeo.com`.

## Object data (Objekt tab)

- **Number of measuring units:** `device_count` of the location detail (`with_measurement_stats` / `prepare_locations`). It was never computed before, so the field stayed empty.
- **Map position:** saving a changed address (street, ZIP, city, country) looks the position up again (Nominatim, `GEOCODE_ON_SAVE`, default on). If nothing is found, the old position stays and the tab says so. Sending latitude/longitude explicitly skips the lookup. A position of 0/0 counts as missing.
- **Locations without GPS:** `python manage.py fix_locations` lists the locations with no position or 0/0 and looks their address up (at most one request per second). It is a dry run by default. `--apply` saves the positions, and `--limit N` looks up only the first N per database.
