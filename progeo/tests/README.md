Rebuild the test database from scratch (drops unit_tests, unit_tests_demo and
unit_tests_project_*, migrates and seeds the baseline - also after new migrations):

python manage.py recreate_test_db --settings=progeo.tests.settings

playwright codegen --ignore-https-errors -o recorded_script_name.py https://progeo.com
playwright codegen --ignore-https-errors -o recorded_script_name.py http://192.168.0.107:3003

playwright codegen --ignore-https-errors --load-storage=auth.json -o recorded_script_name.py https://progeo.com
playwright codegen --ignore-https-errors --load-storage=progeo/tests/auth.json -o recorded_script_name.py http://192.168.0.107:3003
