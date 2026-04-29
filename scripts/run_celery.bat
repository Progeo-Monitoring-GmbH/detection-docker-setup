REM run_celery.bat:
@echo off
call ..\venv\Scripts\activate
celery -A progeo.celery worker --loglevel=INFO
echo DONE!
