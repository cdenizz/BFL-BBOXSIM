@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 serve.py
) else (
    where python >nul 2>nul
    if %errorlevel%==0 (
        python serve.py
    ) else (
        echo Python 3 bulunamadi. Python 3 kurup yeniden calistir.
        pause
    )
)
