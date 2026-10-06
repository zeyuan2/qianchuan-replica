@echo off
setlocal
cd /d "%~dp0"
if not exist ".runtime" mkdir ".runtime"
set "QC_PREVIEW_NODE=C:\Program Files\nodejs\node.exe"
if not exist "%QC_PREVIEW_NODE%" (
  echo Node.js was not found at: %QC_PREVIEW_NODE%
  pause
  exit /b 1
)
echo LOCAL SYNTHETIC PREVIEW ONLY - no real Qianchuan operations.
echo Keep this window open. When ready, visit http://127.0.0.1:5189/
"%QC_PREVIEW_NODE%" "%~dp0scripts\preview-batch.mjs" 2>".runtime\batch-preview-start-error.log"
echo.
echo Preview process has stopped. Error details:
type ".runtime\batch-preview-start-error.log"
pause
