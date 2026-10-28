# Frontend routes

This document lists the client-side routes declared by `frontend/src/CoreRoutes.jsx`.
These are browser URLs served by the frontend, not backend API endpoints. Dynamic
segments such as `:id` and `:account` are path parameters.

## Authentication and public pages

| Route | Purpose |
| --- | --- |
| `/login` | Sign-in page. Supports a `forward` query parameter so the user can be returned to the page they originally requested. |
| `/demo/login/:token` | Demo entry link. Exchanges the demo LimitedToken for a JWT of the read-only `demo` user and redirects to `/demo/` (or `?forward=`, used when an expired demo session logs in again). Print the link with `python manage.py demo_account`. |
| `/demo/` | Opens the first demo location in the regular portal (`/location/:id/status`). The demo user sees the normal layout (sidebar, top bar with a Demo badge, profile, language) for the demo account's smartex® dm, smartex® is and LoRaWAN locations; every write is refused by `DemoReadOnlyMiddleware`. |
| `/demo/location/:id` | Older demo links: redirects to `/location/:id/status`. |
| `/datenschutz` | Public privacy policy page. |
| `/privacy` | Legacy/alternate privacy URL; redirects to `/datenschutz`. |
| `/setup/:account/controller/qrcodes/` | Controller QR-code print sheet for the specified account. Rendered outside the application sidebar layouts. |

## Location monitoring portal

These routes use the location portal layout, which loads the location identified by `:id` and displays its sidebar. Portal sections check the relevant module permission; a user without access sees an access-denied message.

| Route | Purpose |
| --- | --- |
| `/location/overview/` | Overview of locations; the main home page for accounts with the locations module. |
| `/location/:id/status` | Location status dashboard, including status indicators and suspected issues. |
| `/location/:id/objekt` | Location/object information and details. |
| `/location/:id/analyse` | Measurement analysis for the location. |
| `/location/:id/benachrichtigungen` | Configure and review location notifications. |
| `/location/:id/rechte` | Manage access rights for the location. |
| `/location/:id/einstellungen` | Configure location settings, including thresholds and system settings. |
| `/location/:id/schnittstelle` | Configure location interfaces, including integrations such as SMTP, Modbus, and SMS. |
| `/location/:id/detail/` | Retired tab-based location URL; redirects to `/location/:id/status`. |

## Devices, measurements, and alarms

These routes use the general application layout.

| Route | Purpose |
| --- | --- |
| `/device/overview` | List devices and their status; supports device identification and permitted device actions. |
| `/device/:id/editor/` | Edit the configuration of a specific device. |
| `/device/provision/` | Provision a new smartex mx controller (staff or `module_devices_provision`): pick a project/location, set sensors/interval, generate the config (device hash + transfer token) and confirm to create the device under that location. |
| `/device/:id/detail` | View measurement details for a specific device. |
| `/device/:id/update/` | Retired device-configuration URL; looks up the device and redirects to its location settings, or to `/device/overview/` if it has no location or cannot be resolved. |
| `/alarms/` | Overview of alarms. |
| `/alarms/report/` | Alarm report, with time-based report browsing. |
| `/location/:id/alarms` | Alarm details for a specific location. |
| `/location/:id/heatplot` | Location heatplot visualization. |
| `/locations/:id/heatplot` | Alternate plural-form URL for the location heatplot. |
| `/location/:id/heatmap2d` | Two-dimensional heatmap visualization for a location. |

## Administration and operational tools

| Route | Purpose |
| --- | --- |
| `/admin/panel/` | Administrative panel with a live log stream. |
| `/staff/` | Manage staff/user accounts. |
| `/backup/:account/overview/` | View and manage backup information for the specified account. |
| `/docker/` | View Docker container status. |
| `/dev` | Frontend diagnostics and development information. |
| `/ws-debug` | Inspect WebSocket connection and messages. |
| `/factory/` | Factory visualizer. |
| `/lageplan/wizard/` | Wizard for creating or editing a site plan. |
| `/legacy/import/` | Import legacy data. |
| `/map/` | Map view of locations. |
| `/verwaltung/` | Manage existing locations. |
| `/anlegen/` | Create a location and enter its related details. |

## Fallback

| Route | Purpose |
| --- | --- |
| `*` | Any other URL renders the landing page. The landing page sends signed-in users to the locations overview when available, otherwise to an enabled module; unauthenticated users are sent to sign in. |

Routes outside the location monitoring portal use the general application layout
(sidebar and top bar), except for the sign-in, privacy, and QR-code print routes.
