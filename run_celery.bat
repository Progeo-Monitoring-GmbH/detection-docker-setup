REM run_celery.bat:
@echo off
call venv\Scripts\activate
celery -A progeo.celery worker --loglevel=INFO -P eventlet
echo DONE!
