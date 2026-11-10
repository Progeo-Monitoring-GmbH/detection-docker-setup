# Backend tests

The test database must be running and migrated. If it isn't, the run stops
with a message saying which.

```sh
pytest --ds=progeo.tests.settings
pytest --ds=progeo.tests.settings progeo/tests/test_device_commands.py
```

Coverage is opt-in:

```sh
pytest --ds=progeo.tests.settings --cov=progeo --cov-report=html:coverage_html_report
```

The full DEBUG log of every run goes to `progeo/tests/_pytest.log`.

## Rebuilding the test database

Drops `unit_tests`, `unit_tests_demo` and `unit_tests_project_*`, then
migrates and seeds the baseline. Needed after new migrations.

```sh
python manage.py recreate_test_db --settings=progeo.tests.settings
```

CI (`.github/workflows/ci.yml`) does the same on every push: `recreate_test_db`,
`makemigrations --check`, the suite with coverage, plus the frontend checks.

## Recording browser tests

```sh
playwright codegen --ignore-https-errors -o recorded_script_name.py https://progeo.com
playwright codegen --ignore-https-errors -o recorded_script_name.py http://192.168.0.107:3003
playwright codegen --ignore-https-errors --load-storage=auth.json -o recorded_script_name.py https://progeo.com
playwright codegen --ignore-https-errors --load-storage=progeo/tests/auth.json -o recorded_script_name.py http://192.168.0.107:3003
```
