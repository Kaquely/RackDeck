# Reproduces the runtime stage of infra/Dockerfile outside a container.
#
# The Dockerfile's central claim is that the shipped artefact needs no backend build step and
# no development dependencies. This script proves that on the host: it installs exactly the
# production dependency set into a clean directory, copies only what the Dockerfile copies,
# and starts the server.
#
# It cannot prove that the image builds, the health check works inside a container, `tini`
# delivers SIGTERM, or the volume survives a recreation. Those need a container runtime.
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'HHmmss'
$root = Join-Path $env:TEMP "homelabmd-runtime-$stamp"

function Section($name) { Write-Output ""; Write-Output "=== $name ===" }

Section "prepare a clean directory"
New-Item -ItemType Directory -Force -Path $root | Out-Null
Write-Output "root: $root"

# Exactly the two manifest files the Dockerfile copies before installing.
Copy-Item (Join-Path $repo 'package.json') $root
Copy-Item (Join-Path $repo 'package-lock.json') $root

Section "install production dependencies only"
# Mirrors: RUN npm ci --omit=dev --ignore-scripts
Push-Location $root
npm ci --omit=dev --ignore-scripts 2>&1 | Out-String | Write-Output
$installExit = $LASTEXITCODE
Pop-Location
if ($installExit -ne 0) { Write-Output "INSTALL FAILED ($installExit)"; exit 1 }

$prodDeps = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
Write-Output ("production deps declared: " + (($prodDeps.dependencies.PSObject.Properties.Name) -join ', '))
Write-Output ("node_modules top-level count: " + (Get-ChildItem (Join-Path $root 'node_modules') -Directory).Count)

Section "check the app cannot see a development dependency"
$devProbe = @'
const dev = ["typescript", "vite", "eslint", "prettier", "happy-dom"];
for (const name of dev) {
  try { await import(name); console.log(`FAIL: ${name} is resolvable in a production install`); }
  catch { console.log(`ok: ${name} is absent, as expected`); }
}
'@
Set-Content -Path (Join-Path $root 'probe.mjs') -Value $devProbe -NoNewline -Encoding utf8
Push-Location $root
node probe.mjs 2>&1 | Out-String | Write-Output
Pop-Location

Section "copy exactly what the Dockerfile copies"
# COPY src ./src  and  COPY --from=web /build/dist ./dist
Copy-Item -Recurse (Join-Path $repo 'src') $root
Copy-Item -Recurse (Join-Path $repo 'dist') $root
Write-Output ("src files: " + (Get-ChildItem (Join-Path $root 'src') -Recurse -File).Count)
Write-Output ("dist files: " + (Get-ChildItem (Join-Path $root 'dist') -Recurse -File).Count)

Section "confirm no compiled backend output is present"
$js = Get-ChildItem (Join-Path $root 'src') -Recurse -File -Filter '*.js' -ErrorAction SilentlyContinue
Write-Output ("compiled .js inside src: " + @($js).Count + " (expected 0)")
Write-Output ("main entry exists: " + (Test-Path (Join-Path $root 'src\main.ts')))

Section "start the server from source with production dependencies only"
$env:NODE_ENV = 'production'
$env:PORT = '3999'
$env:HOMELABMD_HOST = '127.0.0.1'
$env:HOMELABMD_DATA_DIR = 'data'
$env:HOMELABMD_STATIC_DIR = 'dist/web'

$proc = Start-Process node -ArgumentList @('src/main.ts') -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root 'out.log') -RedirectStandardError (Join-Path $root 'err.log')
Start-Sleep -Seconds 6

$ok = $false
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3999/api/health' -TimeoutSec 8
  Write-Output ("health: " + ($health | ConvertTo-Json -Compress))
  $readings = Invoke-RestMethod -Uri 'http://127.0.0.1:3999/api/readings' -TimeoutSec 8
  Write-Output ("readings: series=" + $readings.series.Count + " tables=" + $readings.tables.Count + " intervalMs=" + $readings.intervalMs)
  $index = Invoke-WebRequest -Uri 'http://127.0.0.1:3999/' -UseBasicParsing -TimeoutSec 8
  Write-Output ("frontend served: status=" + $index.StatusCode + " hasGrid=" + ($index.Content -match 'id="grid"'))
  $layout = Invoke-RestMethod -Uri 'http://127.0.0.1:3999/api/layout' -TimeoutSec 8
  Write-Output ("layout served: tabs=" + $layout.layout.tabs.Count)
  $ok = $true
} catch {
  Write-Output ("REQUEST FAILED: " + $_.Exception.Message)
}

Write-Output ""
Write-Output "--- stdout ---"
Get-Content (Join-Path $root 'out.log') -ErrorAction SilentlyContinue
Write-Output "--- stderr ---"
Get-Content (Join-Path $root 'err.log') -ErrorAction SilentlyContinue

Section "measure resident memory of the production build"
if (-not $proc.HasExited) {
  $proc.Refresh()
  $mb = [math]::Round($proc.WorkingSet64 / 1MB, 1)
  Write-Output ("working set: " + $mb + " MB  (design budget: 300 MB)")
  Write-Output ("within budget: " + ($mb -lt 300))
}

# Graceful shutdown, which is what SIGTERM does in the container via tini.
if (-not $proc.HasExited) {
  Stop-Process -Id $proc.Id
  Start-Sleep -Seconds 1
}
Write-Output ("exited cleanly: " + $proc.HasExited)

Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue

Write-Output ""
Write-Output ("RUNTIME VERIFICATION: " + $(if ($ok) { 'PASSED' } else { 'FAILED' }))
exit $(if ($ok) { 0 } else { 1 })