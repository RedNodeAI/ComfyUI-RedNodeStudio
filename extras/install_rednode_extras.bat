@echo off
REM RedNode Studio extras installer, for the portable ComfyUI on Windows.
REM
REM Installs the node packs the RedNode Studio workflows can use, one at a time, through
REM ComfyUI-Manager's own command line (cm-cli), and says for each one whether it went in.
REM Packs you already have are skipped: nothing is updated, downgraded or removed.
REM
REM Put this file in your ComfyUI_windows_portable folder (next to run_nvidia_gpu.bat),
REM close ComfyUI, and double-click it.

setlocal EnableDelayedExpansion
set "ROOT=%~dp0"
if defined RN_COMFY_ROOT set "ROOT=%RN_COMFY_ROOT%\"
set "PY=%ROOT%python_embeded\python.exe"
set "CMCLI=%ROOT%python_embeded\Scripts\cm-cli.exe"
set "COMFYUI_PATH=%ROOT%ComfyUI"
set "PYTHONUTF8=1"
set "LOG=%TEMP%\rednode_extras_step.txt"

echo.
echo RedNode Studio extras installer
echo ===============================
echo.

if not exist "%PY%" (
  echo This file has to sit in your ComfyUI_windows_portable folder, next to
  echo run_nvidia_gpu.bat. It could not find python_embeded here:
  echo   %ROOT%
  echo.
  echo The ComfyUI desktop app and venv installs keep their Python elsewhere. There,
  echo install the packs from ComfyUI Manager instead.
  goto :done
)

REM ComfyUI must be closed: packs installed under a running ComfyUI fail half-way
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"name='python.exe'\" | Where-Object { $_.ExecutablePath -like '%ROOT%*' }) { exit 1 } else { exit 0 }"
if errorlevel 1 (
  echo ComfyUI is still running from this folder. Close its window first, then run
  echo this again.
  goto :done
)

if not exist "%CMCLI%" (
  echo ComfyUI-Manager is not installed in this ComfyUI yet. Installing it first...
  "%PY%" -s -m pip install -r "%ROOT%ComfyUI\manager_requirements.txt"
  if not exist "%CMCLI%" (
    echo Could not install ComfyUI-Manager. Nothing else was changed.
    goto :done
  )
)

REM id^|name: the Comfy Registry id, or a GitHub address for a pack that is not on it
set PACKS=^
 "rgthree-comfy|rgthree nodes"^
 "derfuu_comfyui_moddednodes|Derfuu Modded Nodes (Text node)"^
 "erosdiffusion-eulerflowmatchingdiscretescheduler|FlowMatch scheduler"^
 "comfyui-krea-moodboards|Krea Moodboards (Style browser)"^
 "https://github.com/ukr8b3g-cmyk/Krea2-BBOX-Prompter|Krea2 BBOX Prompter (Light and Scene)"^
 "ComfyUI-GGUF|GGUF loaders"^
 "seedvr2_videoupscaler|SeedVR2 upscale"^
 "comfyui-vosr2|VOSR 2.0 upscale"^
 "comfyui_ultimatesdupscale|Ultimate SD Upscale (tiled upscale)"^
 "comfyui-easy-sam3|SAM3 masks (Mask detailer, Paint auto mask)"^
 "comfyui-rmbg|RMBG (subject mask)"^
 "comfyui_controlnet_aux|ControlNet aux (depth)"^
 "comfyui-florence2|Florence2 (captions)"^
 "comfyui-wd14-tagger|WD14 tagger (captions)"^
 "ComfyUI-JoyCaption|JoyCaption (captions)"^
 "ComfyUI-QwenVL|QwenVL (captions)"^
 "comfyui-krea2-ostris-edit|Krea2 Ostris edit (Re-render)"^
 "ComfyUI-Apt_Preset|Apt Preset (Re-render)"^
 "comfyui_layerstyle|LayerStyle (Re-render)"^
 "comfyui-post-processing-nodes|Post processing nodes (Re-render)"^
 "RES4LYF|RES4LYF (beta57 schedule, ClownsharKSampler)"^
 "int8-fast|INT8 loader (INT8 W8A8 models)"

set /a TOTAL=0
for %%P in (%PACKS%) do set /a TOTAL+=1
echo These %TOTAL% packs will be installed if they are not here already:
echo.
for %%P in (%PACKS%) do (
  for /f "tokens=1,* delims=|" %%A in (%%P) do echo    %%B
)
echo.
echo Each pack also installs its own Python requirements, as it would from Manager.
echo.
if /i not "%~1"=="/y" (
  choice /c YN /m "Install them now"
  if errorlevel 2 ( echo Nothing was changed. & goto :done )
)

echo.
echo Fetching the pack list...
"%CMCLI%" update-cache >"%LOG%" 2>&1
findstr /l /c:"Cache update complete" "%LOG%" >nul
if errorlevel 1 (
  echo Could not fetch the pack list from the Comfy Registry. Check the internet
  echo connection and run this again. Nothing was changed.
  goto :done
)

set /a N=0, OK=0, SKIP=0, BAD=0
set "FAILED="
for %%P in (%PACKS%) do (
  for /f "tokens=1,* delims=|" %%A in (%%P) do (
    set /a N+=1
    <nul set /p "=[!N!/%TOTAL%] %%B ... "
    "%CMCLI%" install "%%A" >"%LOG%" 2>&1
    findstr /l /c:"[INSTALLED]" "%LOG%" >nul
    if not errorlevel 1 (
      echo installed
      set /a OK+=1
    ) else (
      findstr /l /c:"Already" "%LOG%" >nul
      if not errorlevel 1 (
        echo already here
        set /a SKIP+=1
      ) else (
        echo FAILED
        set /a BAD+=1
        set "FAILED=!FAILED! "%%B""
        copy /y "%LOG%" "%TEMP%\rednode_extras_failed_!N!.txt" >nul
      )
    )
  )
)

echo.
echo ===============================
echo Installed: %OK%   Already here: %SKIP%   Failed: %BAD%
if %BAD% gtr 0 (
  echo.
  echo These did not install:
  for %%F in (!FAILED!) do echo    %%~F
  echo.
  echo What went wrong for each is saved in %TEMP% as rednode_extras_failed_N.txt.
  echo You can also try them one by one from ComfyUI Manager.
)

REM SAM3 imports Triton without listing it, so on a Python without Triton it does not load.
REM Triton must match PyTorch, so this names the right one instead of installing a guess.
if not exist "%ROOT%ComfyUI\custom_nodes\comfyui-easy-sam3" goto :restart
"%PY%" -s -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('triton') else 1)"
if not errorlevel 1 goto :restart
echo.
echo SAM3 masks need Triton, which the SAM3 pack does not install for itself, so it
echo will not load until Triton is added. Triton has to match your PyTorch. With
echo ComfyUI closed, run this in cmd from this folder:
echo.
"%PY%" -s -c "import torch;v='.'.join(torch.__version__.split('+')[0].split('.')[:2]);m={'2.6':'3.2','2.7':'3.3','2.8':'3.4','2.9':'3.5','2.10':'3.6'};t=m.get(v);q=chr(34);print('   python_embeded\\python.exe -s -m pip install '+q+'triton-windows=='+t+'.*'+q if t else '   (PyTorch '+v+' is newer than the table this knows. Pick the triton-windows version for it at https://github.com/woct0rdho/triton-windows)')"

:restart
echo.
echo Start ComfyUI again so the new nodes load.

:done
echo.
if /i not "%~1"=="/y" pause
endlocal
