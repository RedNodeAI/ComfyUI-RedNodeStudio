@echo off
REM RedNode Studio model downloader, for the portable ComfyUI on Windows.
REM
REM Downloads the models, text encoders and VAEs the RedNode Studio 1.6 workflow uses, each
REM from its own publisher (Hugging Face, or Civitai where a model only lives there), into the
REM right ComfyUI model folder. Nothing is re-hosted: every file comes from its source, under
REM its own license. Files already there are skipped; an interrupted download resumes.
REM
REM Put this file in your ComfyUI_windows_portable folder and double-click it.
REM Source: github.com/RedNodeAI/ComfyUI-RedNodeStudio

setlocal EnableDelayedExpansion
title RedNode Studio models
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
set "MODELS=%ROOT%ComfyUI\models"
set "DL=%USERPROFILE%\Downloads"

cls
echo.
echo %RED%
for /f "tokens=1* delims=~" %%a in ('findstr /b "::~" "%~f0"') do echo(%%b
echo %X%
echo    %WHITE%%BOLD%RedNode Studio%X%%GREY%  -  models for your first render%X%
echo.
echo    %GREY%--------------------------------------------------------------------%X%
echo    %WHITE%This downloads the models the RedNode Studio workflow uses:%X%
echo.
echo      %RED%*%X%  Each file comes straight from its publisher, under its own license
echo      %RED%*%X%  Saved into the right ComfyUI folder, with the name the workflow expects
echo      %RED%*%X%  Files you already have are skipped; a stopped download picks up again
echo      %RED%*%X%  Pick only what you want; 1, 6 and 7 are all you need to start
echo    %GREY%--------------------------------------------------------------------%X%
echo.

if not exist "%MODELS%" goto :no_portable
if not exist "%SystemRoot%\System32\curl.exe" goto :no_curl

REM ---- the menu -------------------------------------------------------------------
echo    %WHITE%What would you like?%X%
echo.
set "LASTSEC="
for /f "tokens=2-6 delims=~" %%a in ('findstr /b "::G~" "%~f0"') do (
  if not "%%b"=="!LASTSEC!" (
    echo.
    echo    %RED%%%b%X%
    set "LASTSEC=%%b"
  )
  set /a GB10=%%d/100
  set "GBT=!GB10:~0,-1!.!GB10:~-1!"
  if "!GBT:~0,1!"=="." set "GBT=0!GBT!"
  echo      %RED%%%a%X%  %WHITE%%%c%X%  %GREY%!GBT! GB%X%
  echo         %GREY%%%e%X%
)
echo.
set "SEL=1 6 7"
set "YES="
if /i "%~1"=="/y" (
  set "YES=1"
  if not "%~2"=="" set "SEL=%~2"
  goto :chosen
)
echo    %GREY%Type the numbers you want with spaces between, A for all of them, or just%X%
echo    %GREY%press Enter for 1, 6 and 7: the Krea 2 model and its LoRAs, the recommended start.%X%
set "ANS="
set /p "ANS=   Your choice: "
if defined ANS set "SEL=%ANS%"
if /i "%SEL%"=="A" set "SEL=1 2 3 4 5 6 7 8 9 10 11"
:chosen
set "SEL= %SEL% "

REM ---- what that adds up to -------------------------------------------------------
set /a NEEDMB=0, COUNT=0, NEEDKEY=0
REM a file two picks share (7 and 9) counts once
set "SEEN=|"
for /f "tokens=2-8 delims=~" %%a in ('findstr /b "::M~" "%~f0"') do (
  if not "!SEL: %%a =!"=="!SEL!" if "!SEEN:|%%c|=!"=="!SEEN!" (
    set "SEEN=!SEEN!%%c|"
    if "%%d"=="ollama" (
      set /a COUNT+=1
    ) else if not exist "%MODELS%\%%b\%%c" (
      set /a NEEDMB+=%%f, COUNT+=1
      if "%%d"=="civkey" set NEEDKEY=1
    )
  )
)
if %COUNT% equ 0 (
  echo.
  echo      %GREEN%OK%X%  Everything you picked is already here.
  goto :finish
)
for /f %%f in ('powershell -NoProfile -Command "[math]::Floor((Get-PSDrive '%ROOT:~0,1%').Free/1MB)"') do set "FREEMB=%%f"
set /a NEEDGB=(NEEDMB+999)/1000, FREEGB=FREEMB/1000
echo.
echo    %WHITE%%COUNT% to download, about %NEEDGB% GB into this folder.%X% %GREY%Free on %ROOT:~0,2% %FREEGB% GB. Ollama keeps its own models.%X%
if %FREEMB% lss %NEEDMB% (
  echo.
  echo      %RED%Not enough space.%X% Free up some room on %ROOT:~0,2% or pick fewer, then run this again.
  goto :finish
)
echo    %GREY%By downloading you accept each model's own license, linked above.%X%

REM ---- a Civitai key, only when a picked model needs one ------------------------------
set "CIVKEY="
if %NEEDKEY% equ 0 goto :start
echo.
echo    %WHITE%Some of these live on Civitai, which wants a free account to download them.%X%
echo    %GREY%If you have a Civitai API key (civitai.com, Account settings, API Keys), paste%X%
echo    %GREY%it now. It is used for these downloads only and never saved. Or just press%X%
echo    %GREY%Enter to use your web browser instead: this window moves the file for you.%X%
if /i "%~1"=="/y" goto :start
set "KEYF=%TEMP%\rn_civ_%RANDOM%%RANDOM%.tmp"
powershell -NoProfile -Command "$s = Read-Host '   Civitai key (hidden)' -AsSecureString; $k = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)); [IO.File]::WriteAllText($env:KEYF, $k.Trim())"
if exist "%KEYF%" (
  set /p CIVKEY=<"%KEYF%"
  del /q "%KEYF%" >nul 2>&1
)

REM ---- the downloads --------------------------------------------------------------
:start
echo.
echo    %RED%Downloading%X%  %GREY%big files take a while; the bar shows each one's progress%X%
set /a N=0, OK=0, SKIP=0, BAD=0
set "FAILED="
for /f "tokens=2-8 delims=~" %%a in ('findstr /b "::M~" "%~f0"') do (
  if not "!SEL: %%a =!"=="!SEL!" call :one "%%a" "%%b" "%%c" "%%d" "%%e" "%%f" "%%g"
)
set "CIVKEY="

title RedNode Studio models - done
echo.
echo    %GREY%--------------------------------------------------------------------%X%
if %BAD% equ 0 (
  echo    %GREEN%%BOLD%All done.%X%  %WHITE%%OK% downloaded, %SKIP% already here.%X%
) else (
  echo    %YELLOW%%BOLD%Nearly done.%X%  %WHITE%%OK% downloaded, %SKIP% already here, %BAD% not downloaded.%X%
  for %%F in (!FAILED!) do echo      %RED%-%X%  %%~F
  echo    %GREY%Run this file again to retry; finished files are skipped and a partial%X%
  echo    %GREY%download carries on where it stopped.%X%
)
echo    %GREY%--------------------------------------------------------------------%X%
echo.
echo    %WHITE%Next%X%
echo      %RED%1%X%  If ComfyUI is open, press %WHITE%R%X% in it, or start it with %WHITE%run_nvidia_gpu.bat%X%
echo      %RED%2%X%  Open %WHITE%RedNodeStudio_V1.6%X% from Templates, then press %WHITE%Generate%X%
goto :finish

REM ---- one file ---------------------------------------------------------------------
REM %1 group  %2 folder  %3 name  %4 hf / civ / civkey  %5 url  %6 MB  %7 page
:one
set /a N+=1
set "FOLDER=%~2"
set "NAME=%~3"
set "SRC=%~4"
set "URL=%~5"
set "PAGE=%~7"
set "DEST=%MODELS%\%FOLDER%\%NAME%"
title RedNode Studio models - %NAME%
echo.
if "%SRC%"=="ollama" goto :ollama
echo      %WHITE%%NAME%%X%  %GREY%into models\%FOLDER%%X%
if exist "%DEST%" (
  echo        %GREY%already here%X%
  set /a SKIP+=1
  exit /b
)
if not exist "%MODELS%\%FOLDER%" mkdir "%MODELS%\%FOLDER%"
if "%SRC%"=="civkey" if not defined CIVKEY if defined YES (
  echo        %GREY%needs a Civitai key; skipped in an unattended run%X%
  set /a BAD+=1
  set "FAILED=!FAILED! "%NAME%""
  exit /b
)
if "%SRC%"=="civkey" if not defined CIVKEY goto :browser
set "AUTH="
if "%SRC:~0,3%"=="civ" if defined CIVKEY set "AUTH=-H "Authorization: Bearer !CIVKEY!""
curl.exe -L --fail --retry 3 --retry-delay 5 -C - -# !AUTH! -o "%DEST%.part" "%URL%"
if errorlevel 1 (
  echo        %RED%did not download%X% %GREY%- run this again to retry%X%
  set /a BAD+=1
  set "FAILED=!FAILED! "%NAME%""
  exit /b
)
move /y "%DEST%.part" "%DEST%" >nul
echo        %GREEN%downloaded%X%
set /a OK+=1
exit /b

REM ---- an Ollama model: the Ollama app pulls and stores it itself ----------------------
:ollama
echo      %WHITE%%NAME%%X%  %GREY%into Ollama%X%
set "OLL="
for %%x in (ollama.exe) do if not "%%~$PATH:x"=="" set "OLL=%%~$PATH:x"
if not defined OLL if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLL=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
if not defined OLL (
  echo        %YELLOW%needs the Ollama app%X% - install it from %WHITE%ollama.com/download%X%, then run this again
  set /a BAD+=1
  set "FAILED=!FAILED! "%NAME%""
  exit /b
)
"%OLL%" list 2>nul | findstr /i /l /c:"%NAME%" >nul
if not errorlevel 1 (
  echo        %GREY%already here%X%
  set /a SKIP+=1
  exit /b
)
"%OLL%" pull %NAME%
if errorlevel 1 (
  echo        %RED%did not download%X% %GREY%- is the Ollama app running? Start it and run this again%X%
  set /a BAD+=1
  set "FAILED=!FAILED! "%NAME%""
  exit /b
)
echo        %GREEN%downloaded%X%
set /a OK+=1
exit /b

REM ---- a Civitai model without a key: the browser downloads it, this window moves it --
:browser
echo        %YELLOW%Opening its Civitai page.%X% Click %WHITE%Download%X% there. When it finishes, this
echo        window moves it into place by itself. %GREY%Press S to skip this one.%X%
start "" "%PAGE%"
set /a WAITED=0
:watch
if exist "%DL%\%NAME%" goto :arrived
choice /c WS /t 5 /d W /n >nul
if errorlevel 2 (
  echo        %GREY%skipped%X%
  set /a BAD+=1
  set "FAILED=!FAILED! "%NAME%""
  exit /b
)
set /a WAITED+=5
if %WAITED% geq 3600 (
  echo        %GREY%stopped waiting after an hour%X%
  set /a BAD+=1
  set "FAILED=!FAILED! "%NAME%""
  exit /b
)
goto :watch
:arrived
REM the browser writes a temporary name and renames at the end, so the real name means done
move /y "%DL%\%NAME%" "%DEST%" >nul
echo        %GREEN%moved into place%X%
set /a OK+=1
exit /b

REM ---- the ways it can stop -----------------------------------------------------------
:no_portable
echo      %RED%Stopped.%X%  This file has to sit in your ComfyUI_windows_portable folder, next
echo               to run_nvidia_gpu.bat. It could not find ComfyUI\models here:
echo               %GREY%%ROOT%%X%
goto :finish

:no_curl
echo      %RED%Stopped.%X%  This needs curl, which Windows 10 and 11 include. It was not found.
goto :finish

:finish
echo.
if /i "%~1"=="/y" goto :quit
echo    %GREY%Press any key to close this window.%X%
pause >nul
:quit
endlocal
exit /b

REM ---- the menu: ::G~number~section~title~MB~license or page --------------------------
::G~1~MODELS~Krea 2 Turbo, official - the model, its text encoder and VAE~18630~Krea 2 license: huggingface.co/krea/Krea-2-Turbo
::G~2~MODELS~Qwen Image 2.1 - a second rig, with its own encoder and VAE~24260~Qwen research license: huggingface.co/Qwen/Qwen-Image-2.1
::G~3~MODELS~PornMaster Krea 2 - the workflow's mix rig, from Civitai~19430~Its creator's terms: civitai.com/models/2735032
::G~4~MODELS~JANKU Illustrious - the SDXL rig, from Civitai~6780~Its creator's terms: civitai.com/models/1277670
::G~5~MODELS~ZTurbo - DarkBeast Z-Image Turbo, its abliterated encoder and the UltraFlux VAE~33000~Apache 2.0: GuangyuanSD, IIEleven11, Owen777 on Hugging Face
::G~6~LORAS~The workflow's LoRA set - Identity Edit, Filter Bypass, Refusal Reduction~1860~Each from its author, under its own terms
::G~7~LORAS~Anything2Real - the LoRA the Re-render tab converts with~230~Apache 2.0: huggingface.co/WarmBloodAban/Krea2_Anything2RealCharacters
::G~8~TOOLS~Re-angle - Qwen Image Edit 2511, its encoder, the angles and speed LoRAs~31060~Qwen and Apache 2.0 terms: huggingface.co/Comfy-Org, fal, lightx2v
::G~9~TOOLS~Auto prompt - the Ollama vision model that describes your pictures~6140~Needs the Ollama app (ollama.com). Model: huihui_ai/qwen3-vl-abliterated
::G~10~TOOLS~Swap - the BFS face swap LoRA, on the same Qwen Edit engine as 8~30470~MIT: huggingface.co/Alissonerdx/BFS-Best-Face-Swap. Files 8 already fetched are skipped
::G~11~TOOLS~Masks - ComfyUI's built-in SAM3.1 for the Detailer and Paint, no Triton needed~1750~SAM license: huggingface.co/Comfy-Org/sam3.1

REM ---- the files: ::M~group~folder~save as~hf/civ/civkey~url~MB~page ------------------
::M~1~diffusion_models~krea2TurboOfficialComfy_krea2TurboFp8.safetensors~hf~https://huggingface.co/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_fp8_scaled.safetensors~13140~-
::M~1~text_encoders~qwen3vl_4b_fp8_scaled.safetensors~hf~https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors~5240~-
::M~1~vae~qwen_image_vae.safetensors~hf~https://huggingface.co/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors~250~-
::M~2~diffusion_models~qwen_image_2.1_bf16.safetensors~hf~https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_bf16.safetensors~14230~-
::M~2~text_encoders~qwen3vl_8b_int8_convrot.safetensors~hf~https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors~9350~-
::M~2~vae~qwen_image_2.1_vae_bf16.safetensors~hf~https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors~680~-
::M~3~diffusion_models~pornmasterKrea2_v2TurboInt8.safetensors~civkey~https://civitai.com/api/download/models/3119653~13800~https://civitai.com/models/2735032?modelVersionId=3119653
::M~3~text_encoders~qwen3VLInstruct4bHeretic_v10.safetensors~civ~https://civitai.com/api/download/models/3066989~5120~https://civitai.com/models/2728378?modelVersionId=3066989
::M~3~vae~wan_2.1_vae_fp32.safetensors~hf~https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/Wan2_1_VAE_fp32.safetensors~510~-
::M~4~checkpoints~JANKUTrainedChenkinNoobai_v777.safetensors~civkey~https://civitai.com/api/download/models/2786084~6780~https://civitai.com/models/1277670?modelVersionId=2786084
::M~5~diffusion_models~darkBeast_darkblitz6Beyondnsfw.safetensors~hf~https://huggingface.co/GuangyuanSD/REDCraft-DarkBeast-Z-Image-TURBO/resolve/main/DarkBeast-ZImageTurbo/DarkBeastZ6-BlitZ-F32-ComfyUI.safetensors~24620~-
::M~5~text_encoders~Qwen3-4B-abliterated_dark.safetensors~hf~https://huggingface.co/IIEleven11/Qwen3-4B-abliterated_dark/resolve/main/Qwen3-4B-abliterated_dark.safetensors~8045~-
::M~5~vae~UltraFlux.safetensors~hf~https://huggingface.co/Owen777/UltraFlux-v1/resolve/main/vae/diffusion_pytorch_model.safetensors~335~-
::M~6~loras~krea2_identity_edit_v1_2.safetensors~hf~https://huggingface.co/conradlocke/krea2-identity-edit/resolve/main/krea2_identity_edit_v1_2.safetensors~1828~-
::M~6~loras~krea2filterbypass3.safetensors~civkey~https://civitai.com/api/download/models/3067151~1~https://civitai.com/models/2728234?modelVersionId=3067151
::M~6~loras~Krea2_TextFusion_Refusal_Reduction.safetensors~civkey~https://civitai.com/api/download/models/3125118~27~https://civitai.com/models/2775340?modelVersionId=3125118
::M~7~loras~Krea2_Anything2RealCharacters-V3.safetensors~hf~https://huggingface.co/WarmBloodAban/Krea2_Anything2RealCharacters/resolve/main/Krea2_Anything2RealCharacters-V3.safetensors~230~-
::M~8~diffusion_models~qwen_image_edit_2511_fp8mixed.safetensors~hf~https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors~20530~-
::M~8~text_encoders~qwen_2.5_vl_7b_fp8_scaled.safetensors~hf~https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors~9380~-
::M~8~vae~qwen_image_vae.safetensors~hf~https://huggingface.co/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors~250~-
::M~8~loras~qwen-image-edit-2511-multiple-angles-lora.safetensors~hf~https://huggingface.co/fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA/resolve/main/qwen-image-edit-2511-multiple-angles-lora.safetensors~300~-
::M~8~loras~Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors~hf~https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors~850~-
::M~9~ollama~huihui_ai/qwen3-vl-abliterated:8b-instruct~ollama~huihui_ai/qwen3-vl-abliterated:8b-instruct~6140~https://ollama.com/huihui_ai/qwen3-vl-abliterated
::M~10~diffusion_models~qwen_image_edit_2511_fp8mixed.safetensors~hf~https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors~20530~-
::M~10~text_encoders~qwen_2.5_vl_7b_fp8_scaled.safetensors~hf~https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors~9380~-
::M~10~vae~qwen_image_vae.safetensors~hf~https://huggingface.co/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors~250~-
::M~10~loras~bfs_head_v5_2511_merged_version_rank_16_fp16.safetensors~hf~https://huggingface.co/Alissonerdx/BFS-Best-Face-Swap/resolve/main/bfs_head_v5_2511_merged_version_rank_16_fp16.safetensors~307~-
::M~11~checkpoints~sam3.1_multiplex_fp16.safetensors~hf~https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors~1750~-

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
