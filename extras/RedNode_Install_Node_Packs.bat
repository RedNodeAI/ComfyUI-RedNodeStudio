@echo off
REM RedNode Studio installer, for the portable ComfyUI on Windows.
REM
REM Installs RedNode Studio and the node packs its workflows use, one at a time, through
REM ComfyUI-Manager's own command line (cm-cli), and says for each one whether it went in.
REM Packs you already have are skipped: nothing is updated, downgraded or removed.
REM
REM Put this file in your ComfyUI_windows_portable folder (next to run_nvidia_gpu.bat),
REM close ComfyUI, and double-click it. Source: github.com/RedNodeAI/ComfyUI-RedNodeStudio

setlocal EnableDelayedExpansion
title RedNode Studio node pack installer
for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "RED=%ESC%[91m"
set "WHITE=%ESC%[97m"
set "GREY=%ESC%[90m"
set "GREEN=%ESC%[92m"
set "YELLOW=%ESC%[93m"
set "BOLD=%ESC%[1m"
set "X=%ESC%[0m"

set "ROOT=%~dp0"
if defined RN_COMFY_ROOT set "ROOT=%RN_COMFY_ROOT%\"
set "PY=%ROOT%python_embeded\python.exe"
set "CMCLI=%ROOT%python_embeded\Scripts\cm-cli.exe"
set "COMFYUI_PATH=%ROOT%ComfyUI"
set "PYTHONUTF8=1"
set "LOG=%TEMP%\rednode_node_packs_step.txt"

cls
echo.
echo %RED%
for /f "tokens=1* delims=~" %%a in ('findstr /b "::~" "%~f0"') do echo(%%b
echo %X%
echo    %WHITE%%BOLD%RedNode Studio%X%%GREY%  -  a calmer way into ComfyUI%X%
echo.
echo    %GREY%--------------------------------------------------------------------%X%
echo    %WHITE%This sets up RedNode Studio in this ComfyUI folder:%X%
echo.
echo      %RED%*%X%  RedNode Studio, plus the node packs its workflows use
echo      %RED%*%X%  Installed by ComfyUI Manager, from the official Comfy Registry
echo      %RED%*%X%  It only adds to this folder. Nothing is deleted or changed elsewhere
echo      %RED%*%X%  No account, no admin rights, nothing to configure
echo      %RED%*%X%  About 10 to 20 minutes, mostly downloading
echo      %RED%*%X%  Safe to close at any time and run again: it picks up where it left off
echo    %GREY%--------------------------------------------------------------------%X%
echo.

REM ---- checks ---------------------------------------------------------------------
echo    %WHITE%Checking this folder%X%
if not exist "%PY%" goto :no_portable
echo      %GREEN%OK%X%  Found ComfyUI's own Python

powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"name='python.exe'\" | Where-Object { $_.ExecutablePath -like '%ROOT%*' }) { exit 1 } else { exit 0 }"
if errorlevel 1 goto :comfy_running
echo      %GREEN%OK%X%  ComfyUI is closed

if exist "%CMCLI%" goto :manager_ready
echo      %YELLOW%..%X%  ComfyUI Manager is not here yet, adding it first %GREY%(a minute or two)%X%
echo %GREY%
"%PY%" -s -m pip install -q --no-warn-script-location -r "%ROOT%ComfyUI\manager_requirements.txt"
echo %X%
if not exist "%CMCLI%" goto :no_manager
set "MANAGER_NEW=1"
:manager_ready
echo      %GREEN%OK%X%  ComfyUI Manager is ready
echo.

REM id^|name: the Comfy Registry id, or a GitHub address for a pack that is not on it
set PACKS=^
 "rednode-studio|RedNode Studio"^
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
 "comfyui-ollama-describer|Ollama describer (Ollama captions; needs the Ollama app)"^
 "comfyui-krea2-ostris-edit|Krea2 Ostris edit (Re-render)"^
 "ComfyUI-Apt_Preset|Apt Preset (Re-render)"^
 "comfyui_layerstyle|LayerStyle (Re-render)"^
 "comfyui-post-processing-nodes|Post processing nodes (Re-render)"^
 "RES4LYF|RES4LYF (beta57 schedule, ClownsharKSampler)"^
 "int8-fast|INT8 loader (INT8 W8A8 models)"

set /a TOTAL=0
for %%P in (%PACKS%) do set /a TOTAL+=1
echo    %WHITE%What gets installed%X% %GREY%(%TOTAL% packs, any you already have are skipped)%X%
echo.
set /a I=0
for %%P in (%PACKS%) do (
  for /f "tokens=1,* delims=|" %%A in (%%P) do (
    set /a I+=1
    set "NUM=  !I!"
    echo      %GREY%!NUM:~-2!%X%  %%B
  )
)
echo.
if /i "%~1"=="/y" goto :go
echo    %WHITE%Ready?%X%  %GREY%Y starts, N closes without changing anything.%X%
choice /c YN /n /m "   Start the install [Y/N] "
if errorlevel 2 goto :cancelled
:go

REM ---- step 1: the pack list ------------------------------------------------------
echo.
echo    %RED%Step 1 of 2%X%  %WHITE%Getting the pack list from the Comfy Registry%X% %GREY%(about a minute)%X%
title RedNode Studio node pack installer - getting the pack list
echo %GREY%
"%CMCLI%" update-cache
echo %X%
dir /b "%COMFYUI_PATH%\user\__manager\cache\*custom-node-list.json" >nul 2>&1
if errorlevel 1 goto :no_list
echo      %GREEN%OK%X%  Pack list ready
echo.

REM ---- step 2: the packs ----------------------------------------------------------
echo    %RED%Step 2 of 2%X%  %WHITE%Installing, one pack at a time%X%
echo    %GREY%Each pack also downloads its own Python packages, so a big one can sit on%X%
echo    %GREY%its line for a few minutes. The window has not frozen; it moves on by itself.%X%
echo.
set /a N=0, OK=0, SKIP=0, BAD=0
set "FAILED="
for %%P in (%PACKS%) do (
  for /f "tokens=1,* delims=|" %%A in (%%P) do (
    set /a N+=1
    set "NUM=  !N!"
    title RedNode Studio node pack installer - !N! of %TOTAL% - %%B
    <nul set /p "=%GREY%     !NUM:~-2!/%TOTAL%%X%  %%B ... "
    "%CMCLI%" install "%%A" >"%LOG%" 2>&1
    findstr /l /c:"[INSTALLED]" "%LOG%" >nul
    if not errorlevel 1 (
      echo %GREEN%installed%X%
      set /a OK+=1
    ) else (
      findstr /l /c:"Already" "%LOG%" >nul
      if not errorlevel 1 (
        echo %GREY%already here%X%
        set /a SKIP+=1
      ) else (
        echo %RED%did not install%X%
        set /a BAD+=1
        set "FAILED=!FAILED! "%%B""
        copy /y "%LOG%" "%TEMP%\rednode_node_packs_failed_!N!.txt" >nul
      )
    )
  )
)

REM ---- the end --------------------------------------------------------------------
title RedNode Studio node pack installer - done
echo.
echo    %GREY%--------------------------------------------------------------------%X%
if %BAD% equ 0 (
  echo    %GREEN%%BOLD%All done.%X%  %WHITE%%OK% installed, %SKIP% already here.%X%
) else (
  echo    %YELLOW%%BOLD%Nearly done.%X%  %WHITE%%OK% installed, %SKIP% already here, %BAD% did not install.%X%
  echo.
  echo    %WHITE%These did not go in:%X%
  for %%F in (!FAILED!) do echo      %RED%-%X%  %%~F
  echo.
  echo    %GREY%RedNode Studio still works without them; only the parts that use them wait.%X%
  echo    %GREY%Run this file again later, or install them from ComfyUI Manager. The reason%X%
  echo    %GREY%for each is saved in %TEMP% as rednode_node_packs_failed_N.txt%X%
)
echo    %GREY%--------------------------------------------------------------------%X%
echo.
echo    %WHITE%Next%X%
echo      %RED%1%X%  Start ComfyUI with %WHITE%run_nvidia_gpu.bat%X% in this folder
echo      %RED%2%X%  In ComfyUI open %WHITE%Templates%X%, then %WHITE%RedNode Studio%X%, then %WHITE%RedNodeStudio_V1.6%X%
echo.

REM SAM3 imports Triton without listing it, so on a Python without Triton it does not load.
REM Triton must match PyTorch, so this names the right one instead of installing a guess.
set "SAM3NOTE="
if not exist "%ROOT%ComfyUI\custom_nodes\comfyui-easy-sam3" goto :notes
"%PY%" -s -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('triton') else 1)"
if errorlevel 1 set "SAM3NOTE=1"
:notes
if not defined SAM3NOTE if not defined MANAGER_NEW goto :done
echo    %WHITE%Good to know%X% %GREY%- optional, nothing here stops you%X%
if not defined SAM3NOTE goto :note_manager
echo      %GREY%-%X%  SAM3 automatic masks need one more piece, Triton, before they load.
echo         %GREY%Everything else works without it.%X%
"%PY%" -s -c "import torch;v='.'.join(torch.__version__.split('+')[0].split('.')[:2]);m={'2.6':'3.2','2.7':'3.3','2.8':'3.4','2.9':'3.5','2.10':'3.6'};t=m.get(v);q=chr(34);print('         To add it now, close ComfyUI and run this from this folder:\n           python_embeded\\python.exe -s -m pip install '+q+'triton-windows=='+t+'.*'+q if t else '         No Triton build matches this ComfyUI yet.')"
echo         %GREY%Or skip Triton: model downloader item 10 gets ComfyUI's own SAM3.1, which
echo         needs no Triton; pick it as the SAM file on the Detailer tab.%X%
:note_manager
if not defined MANAGER_NEW goto :notes_end
echo      %GREY%-%X%  ComfyUI Manager was added too. To see its window in ComfyUI, add
echo         %WHITE%--enable-manager%X% to the end of the python line in run_nvidia_gpu.bat
:notes_end
echo.
goto :done

REM ---- the ways it can stop, each in plain words -------------------------------------
:no_portable
echo.
echo      %RED%Stopped.%X%  This file has to sit in your ComfyUI_windows_portable folder,
echo               next to run_nvidia_gpu.bat. It looked for ComfyUI's Python here:
echo               %GREY%%ROOT%%X%
echo.
echo               Using the ComfyUI desktop app, or a venv install? Install the packs
echo               from ComfyUI Manager instead. Nothing was changed.
goto :done

:comfy_running
echo.
echo      %YELLOW%One moment.%X%  ComfyUI is running from this folder. Close its window,
echo                   then double-click this file again. Nothing was changed.
goto :done

:no_manager
echo.
echo      %RED%Stopped.%X%  ComfyUI Manager could not be added, so nothing else was installed.
echo               Check the internet connection and run this file again.
goto :done

:no_list
echo.
echo      %RED%Stopped.%X%  The pack list could not be fetched from the Comfy Registry.
echo               Check the internet connection and run this file again.
echo               Nothing was installed.
goto :done

:cancelled
echo.
echo      %GREY%Closed without changing anything.%X%
goto :done

:done
echo.
if /i "%~1"=="/y" goto :quit
echo    %GREY%Press any key to close this window.%X%
pause >nul
:quit
endlocal
exit /b

::~          .-"-.               .-"-.
::~         /     \   .-"""-.   /     \
::~         \  .-. \ /       \ / .-.  /
::~          \(  O )|  .- -.  |(  O )/
::~            '-'  | ( o o ) |  '-'
::~                 \  '-^-'  /
::~                  '-.___.-'
::~
::~    ____          _ _   _           _
::~   |  _ \ ___  __| | \ | | ___   __| | ___
::~   | |_) / _ \/ _` |  \| |/ _ \ / _` |/ _ \
::~   |  _ <  __/ (_| | |\  | (_) | (_| |  __/
::~   |_| \_\___|\__,_|_| \_|\___/ \__,_|\___|
