@echo off
pushd "%~dp0.."
if not exist ".organizer" mkdir ".organizer"
pi -a -p "/daily-brief" >> ".organizer\daily-brief.log" 2>&1
set "organizer_result=%errorlevel%"
popd
exit /b %organizer_result%
