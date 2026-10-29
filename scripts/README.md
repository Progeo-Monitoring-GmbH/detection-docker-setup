# scripts

Helper scripts for installing, operating and developing the ProGeo detection
stack. Unless noted otherwise, run them from the repository root.

Scripts marked **root** must be run with `sudo`. They target Debian/Ubuntu
or Raspberry Pi OS.

## Installation & system setup

| Script | Purpose |
| --- | --- |
| `install.sh` | One-line installer: clones the repo into the current (empty) directory and runs `setup_system.sh`. It does not start the containers; it prints the `finalize-install.sh` command to run after editing `.env` / `django.env`. **root** |
| `finalize-install.sh` | Second installation step: builds and starts all containers once `.env` / `django.env` have been edited. **root** |
| `deploy.sh` | Deploys the checked-out code with minimal downtime. It builds the images and runs the migrations and syncs with the new image while the old containers keep serving, then recreates the changed containers, waits for the backend and follows its log. If the migrations fail, nothing is restarted. Output is also written to `logs/deploy.log`. Migrations must stay compatible with the old code. |
| `setup_system.sh` | Installs Docker, Docker Compose and Git, adds the sudo user to the `docker` group, enables UFW (ports 22/80/443), and creates `.env` / `django.env` from their templates. Every `~` in those files is replaced with a random character. **root** |
| `install_git_docker_windows.bat` | Windows Server equivalent: enables WSL2, installs Git and Docker Desktop, and clones the repo. Run as Administrator; a reboot is needed afterwards. |
| `setup_buildx.sh` | Purges Docker completely and reinstalls it with the Buildx and Compose plugins, then rebuilds all images. **Deletes all containers, images and volumes.** It offers a database backup first. **root** |

```bash
# Fresh machine (run inside an empty directory)
curl -fsSL https://raw.githubusercontent.com/Progeo-Monitoring-GmbH/detection-docker-setup/main/scripts/install.sh | sudo bash

# Other branch
curl -fsSL .../scripts/install.sh | sudo BRANCH=dev bash

# After editing .env / django.env: build and start the containers
sudo bash scripts/finalize-install.sh

# Live server: deploy the checked-out code (replaces build + up -d + tail)
bash scripts/deploy.sh
bash scripts/deploy.sh --no-follow   # without following the backend log

# Already cloned: only prepare the system
sudo bash scripts/setup_system.sh
```

```bat
:: Windows Server, from an elevated prompt
scripts\install_git_docker_windows.bat C:\Progeo\code
```

## Networking (Raspberry Pi controller)

| Script | Purpose |
| --- | --- |
| `setup_wifi.sh` | Turns `wlan0` into the controller hotspot (hostapd + dnsmasq). The SSID, password, country and IP come from `.env` (`CONTROLLER_*`). Credentials saved from the dashboard (`media/setup/controller_wifi.env`) take precedence, and a systemd path unit reapplies them whenever they change. **root** |
| `setup_uplink_network.sh` | Wired uplink: tries DHCP first and falls back to the static address from `.env` (`UPLINK_*`). A systemd timer switches back to DHCP once a server answers. Supports NetworkManager and dhcpcd. **root** |
| `dhcp_probe.py` | Sends one DHCPDISCOVER and reports whether a server offers an address, without taking a lease. Used by `setup_uplink_network.sh --check`. Exit codes: 0 = offer, 1 = no offer, 2 = error. **root** |
| `ip_change_logger.sh` | Appends a line to `logs/backend/IP.txt` each time the uplink IP changes, including an internet connectivity check. Can be installed as a systemd service. |
| `network_report.sh` | Writes a network diagnostics report for the network admin: findings first (link, DHCP, IP conflict, gateway, DNS registration of the hostname, mDNS/LLMNR, firewall, switch port via LLDP/CDP), then the raw command output. Saved to `logs/network_report/latest.txt` and copied to the boot partition (`network_report.txt`). `--install` runs it 3 min after every boot. **root** |
| `setup_reverse_ssh_shell.sh` | Sets up a persistent reverse SSH tunnel (autossh + systemd), so the device stays reachable behind NAT. **root** |

```bash
sudo bash scripts/setup_wifi.sh

sudo bash scripts/setup_uplink_network.sh              # configure and apply
sudo bash scripts/setup_uplink_network.sh --check      # back to DHCP if a server answers
sudo bash scripts/setup_uplink_network.sh --uninstall  # plain DHCP again

sudo python3 scripts/dhcp_probe.py eth0 10             # interface, timeout in seconds

bash scripts/ip_change_logger.sh --once                # log the current state once
sudo bash scripts/ip_change_logger.sh --install        # run as a service at boot

sudo bash scripts/network_report.sh                    # write a report now (~2 min)
sudo bash scripts/network_report.sh --install          # write one after every boot

sudo bash scripts/setup_reverse_ssh_shell.sh \
  --server ubuntu@example.com --remote-port 22022 --install-key
```

## TLS / domains

| Script | Purpose |
| --- | --- |
| `setup_certbot.sh` | Requests Let's Encrypt certificates (webroot challenge), reloads `progeo-nginx` and installs a daily renewal cron job. **root** |
| `check_https_local.ps1` | Windows dev check for local HTTPS. For every domain in `DNS_BACK_NAMES` / `DNS_FRONT_NAMES` it verifies the hosts-file entry, the nginx container, the TLS handshake, certificate expiry, SAN and Windows trust, and whether Firefox trusts the mkcert root. |
| `subdomain_audit.py` | Checks DNS and HTTP(S) for each progeo.com subdomain and classifies it as ACTIVE, DEAD or SUSPICIOUS, which makes unused subdomains easy to spot. |

```bash
sudo bash scripts/setup_certbot.sh admin@progeo.com portal.progeo.com api.progeo.com

python scripts/subdomain_audit.py --json report.json --timeout 8 --workers 12
```

```powershell
.\scripts\check_https_local.ps1 -EnvFile .env -Port 443 -VerboseChecks
```

## Building & publishing images

| Script | Purpose |
| --- | --- |
| `build_push_images.sh` / `.ps1` | Builds, tags, signs (Docker Content Trust) and pushes the images to `progeomonitoring/detection-docker-setup:<service>-<VERSION>`. `VERSION` defaults to today's date. |
| `build_cad_factory_resilient.sh` | Builds the `progeo-cad_factory` image in the background, so the build survives an SSH disconnect. |

```bash
VERSION=1.0.0 ./scripts/build_push_images.sh
INCLUDE_CAD_FACTORY=1 ./scripts/build_push_images.sh
DOCKER_USERNAME=progeo DOCKER_PASSWORD="$TOKEN" ./scripts/build_push_images.sh   # non-interactive

bash scripts/build_cad_factory_resilient.sh start   # then: status | logs | stop
```

```powershell
$env:VERSION = '1.0.0'; .\scripts\build_push_images.ps1
```

If 2FA is enabled on the Docker Hub account, use a personal access token
as the password.

## Maintenance

| Script | Purpose |
| --- | --- |
| `cleanup_media_backup.sh` | Keeps only the newest N `*.psql` backups per database in `media/backup` (default 10) and deletes the rest along with their `.metadata` files. |
| `reclaim_docker_space.sh` | Prunes stopped containers, networks, build cache and dangling images, and cleans apt caches, `/tmp`, old journals and trash. Volumes are only removed with `--volumes`. **root** |

```bash
bash scripts/cleanup_media_backup.sh --keep=5 --dry-run   # preview first
bash scripts/cleanup_media_backup.sh --keep=5

sudo bash scripts/reclaim_docker_space.sh                 # safe default
sudo bash scripts/reclaim_docker_space.sh --all-images --volumes
```

## Development

| Script | Purpose |
| --- | --- |
| `run_pytest_unit_tests.sh` / `.bat` | Activates `venv` and runs pytest with `progeo.tests.settings`. Any arguments are passed through to pytest. |
| `pytest_selector.py` / `.bat` | Interactive test picker: choose files, classes or single tests with the arrow keys and space, then run them. Needs `prompt_toolkit`. |
| `run_celery.bat` | Starts a local Celery worker (Windows). Run it from inside `scripts/`. |

```bash
bash scripts/run_pytest_unit_tests.sh progeo/tests/test_device_lorawan.py -x
python scripts/pytest_selector.py
```

```bat
scripts\run_pytest_unit_tests.bat -k lorawan
cd scripts && run_celery.bat
```

The unit tests need the Postgres container on port 5435 (see `.env`).
