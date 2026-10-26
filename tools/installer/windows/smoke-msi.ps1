param([Parameter(Mandatory=$true)][string]$PackageDirectory)
$ErrorActionPreference = 'Stop'
$msi = (Get-ChildItem $PackageDirectory -Filter *.msi | Select-Object -First 1).FullName
if (-not $msi) { throw 'No MSI was generated' }
$install = Join-Path $env:ProgramW6432 'MES Homework'
$report = Join-Path $env:RUNNER_TEMP 'native-msi-smoke.json'
function Invoke-Msi([string]$Arguments) {
  $log = Join-Path $env:RUNNER_TEMP ('msi-' + [guid]::NewGuid().ToString() + '.log')
  $p = Start-Process msiexec.exe -ArgumentList ($Arguments + ' /qn /norestart /l*v "' + $log + '"') -PassThru
  if (-not $p.WaitForExit(180000)) { $p.Kill(); Get-Content $log -Tail 100; throw 'MSI did not finish within the bounded test deadline' }
  if ($p.ExitCode -notin @(0,3010)) { Get-Content $log -Tail 100; throw "MSI failed with exit $($p.ExitCode)" }
}
Invoke-Msi ('/i "' + $msi + '" ADDLOCAL=Application,Server')
try {
  if (-not (Test-Path (Join-Path $install 'MESHomework.exe'))) { throw 'Native application launcher missing' }
  $serviceData = Join-Path $env:ProgramData 'MESHomework'
  node tools/installer/smoke-service.mjs (Join-Path $serviceData 'instance.json')
  if ($LASTEXITCODE) { throw 'LocalService startup failed' }
  node tools/installer/smoke-installed.mjs --entry (Join-Path $install 'MESHomework.exe') --report $report
  if ($LASTEXITCODE) { throw 'MSI installed runtime smoke failed' }
  # Standard MSI repair must retain both service and local user configuration.
  Invoke-Msi ('/fa "' + $msi + '"')
  node tools/installer/check-retained-data.mjs $report
  if ($LASTEXITCODE) { throw 'Repair removed synthetic data' }
  node tools/installer/smoke-service.mjs (Join-Path $serviceData 'instance.json')
  if ($LASTEXITCODE) { throw 'Service did not recover after repair' }
} finally {
  Invoke-Msi ('/x "' + $msi + '"')
}
if (Test-Path (Join-Path $install 'MESHomework.exe')) { throw 'Uninstall left application executable behind' }
node tools/installer/check-retained-data.mjs $report
if ($LASTEXITCODE) { throw 'Uninstall removed synthetic data' }
if (-not (Test-Path (Join-Path $serviceData '.env'))) { throw 'Uninstall removed service master key configuration' }
