playwright codegen --ignore-https-errors -o recorded_script_name.py https://progeo.local
playwright codegen --ignore-https-errors -o recorded_script_name.py http://192.168.0.107:3003

playwright codegen --ignore-https-errors --load-storage=auth.json -o recorded_script_name.py https://progeo.local
playwright codegen --ignore-https-errors --load-storage=progeo/tests/auth.json -o recorded_script_name.py http://192.168.0.107:3003
