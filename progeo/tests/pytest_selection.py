"""Functional markers and opt-in selection of failed tests and dependents."""

from pathlib import Path

import pytest

AREA_MODULES = {
    "access": """
        access_and_login_links access_scoping_api account_middleware authentication_order
        location_access module_permissions_as_user monitoring_auth oidc rechte_api
        staff_admin_api staff_impersonation user_management_security user_profile
    """,
    "alarms": """
        admin_overview_and_test_notification alarm_episodes alarm_evaluation_and_check alarm_thresholds_unit
        alarm_overview_api alarm_report_api alarm_severity_and_clusters escalations_api
    """,
    "backups": """
        backup_download backup_transfer dbbackup_connector import_live_backup restore_backups
        sync_backups
    """,
    "databases": """
        admin_db_switch adv_migrate drop_samples_migration handle_all_dbs
        legacy_file_migration merge_duplicate_locations project_dbs pytest_database_setup pytest_selection
        relink_locations_command router_regressions split_views sync_default_skipping
    """,
    "demo": "demo_account_areas demo_view",
    "devices": """
        controller_qrcodes controller_wifi device_commands device_legacy_query
        device_lorawan device_overview device_provisioning device_statistics_api
        firmware_upload
    """,
    "exports": "exports lageplan_export",
    "integrations": """
        airtable_locations cad_import data_transfer_api interface_api legacy_gprs
        matrix_account_sync modbus_tcp
    """,
    "locations": """
        favorites_api koords_to_points lageplan_edit location_geo_and_admin_api
        location_timeline_and_measurepoints measurepoints_api plan_meters rain_events status_api
    """,
    "measurements": """
        catch_up_legacy_files climate_heatmap evaluate_measurement heatmap_video
        heat_limitations_api location_climate measurement_history noise_profiles
    """,
    "notifications": "bounces_and_notifications email_and_sms_helpers messenger outbound test_mail_command",
    "operations": """
        celery_schedule clear_logs deployment_settings docker_agent docker_api health logging_handler log_stream metrics
        periodic_task_skipping sentry_shutdown task_config_errors
    """,
}

_MODULE_AREAS = {
    f"test_{module}.py": area
    for area, modules in AREA_MODULES.items()
    for module in modules.split()
}
_HTTP_FIXTURES = {"api_client", "api_client_with_credentials", "client", "admin_client"}


def pytest_addoption(parser):
    parser.getgroup("test selection").addoption(
        "--failed-dependents",
        action="store_true",
        help="run cached failures and their explicitly declared downstream dependents",
    )


def _dependencies(item):
    for marker in item.iter_markers("depends_on"):
        if marker.kwargs or not marker.args or not all(
            isinstance(nodeid, str) and nodeid for nodeid in marker.args
        ):
            raise pytest.UsageError(
                f"{item.nodeid}: depends_on requires one or more nonempty node ID strings"
            )
        yield from marker.args


@pytest.hookimpl(tryfirst=True)
def pytest_collection_modifyitems(config, items):
    for item in items:
        area = _MODULE_AREAS.get(Path(str(item.path)).name)
        if area:
            item.add_marker(getattr(pytest.mark, area))
        if _HTTP_FIXTURES.intersection(item.fixturenames):
            item.add_marker(pytest.mark.http_client)

    if not config.getoption("--failed-dependents"):
        return
    if config.getoption("lf") or config.getoption("failedfirst"):
        raise pytest.UsageError("--failed-dependents cannot be combined with --lf or --ff")

    last_failed = config.cache.get("cache/lastfailed", {})
    if not last_failed:
        raise pytest.UsageError("--failed-dependents: no cached failures; run tests first")
    failed_ids = {nodeid for nodeid, failed in last_failed.items() if failed}
    dependencies = {item.nodeid: set(_dependencies(item)) for item in items}
    selected = {
        item.nodeid
        for item in items
        if any(item.nodeid == failed or item.nodeid.startswith(failed + "::") for failed in failed_ids)
    }
    if not selected:
        raise pytest.UsageError("--failed-dependents: cached failures are not in the collected tests")

    while True:
        downstream = {nodeid for nodeid, upstream in dependencies.items() if upstream & selected}
        expanded = selected | downstream
        if expanded == selected:
            break
        selected = expanded

    kept = [item for item in items if item.nodeid in selected]
    deselected = [item for item in items if item.nodeid not in selected]
    if deselected:
        config.hook.pytest_deselected(items=deselected)
    items[:] = kept
