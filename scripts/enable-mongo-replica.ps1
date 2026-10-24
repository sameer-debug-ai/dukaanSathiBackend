# Converts the local "MongoDB" Windows service into a single-node replica set (rs0)
# so DukaanSathi can use transactions. Existing data is kept.
#
# Run ONCE from an Administrator PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\scripts\enable-mongo-replica.ps1   (from the backend repo root)

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Please run this script from an Administrator PowerShell.' }

$svc = Get-CimInstance Win32_Service -Filter "Name='MongoDB'"
if (-not $svc) { throw 'MongoDB Windows service not found.' }
$cfg = [regex]::Match($svc.PathName, '--config\s+"?([^"]+?)"?(\s|$)').Groups[1].Value
if (-not (Test-Path $cfg)) { throw "mongod.cfg not found at '$cfg'" }
Write-Host "Config: $cfg"

$text = Get-Content $cfg -Raw
if ($text -match '(?m)^replication:') {
  Write-Host 'Replication already configured - skipping config edit.'
} else {
  Copy-Item $cfg "$cfg.bak" -Force
  Write-Host "Backup saved: $cfg.bak"
  if ($text -match '(?m)^#replication:') {
    $text = $text -replace '(?m)^#replication:.*$', "replication:`r`n  replSetName: rs0"
  } else {
    $text = $text.TrimEnd() + "`r`n`r`nreplication:`r`n  replSetName: rs0`r`n"
  }
  Set-Content -Path $cfg -Value $text -Encoding ascii
  Write-Host 'Added replication.replSetName: rs0'
}

Write-Host 'Restarting MongoDB service...'
Restart-Service MongoDB
Start-Sleep -Seconds 3

# Initiate the replica set using the server's mongoose (mongosh is not required).
$serverDir = Join-Path $PSScriptRoot '..'
$js = @'
const m = require('mongoose');
(async () => {
  const c = await m.createConnection('mongodb://127.0.0.1:27017/?directConnection=true', { serverSelectionTimeoutMS: 15000 }).asPromise();
  const admin = c.db.admin();
  try {
    await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] } });
    console.log('Replica set rs0 initiated');
  } catch (e) {
    if (e.codeName === 'AlreadyInitialized') console.log('Replica set already initiated');
    else throw e;
  }
  for (let i = 0; i < 30; i++) {
    const h = await admin.command({ hello: 1 });
    if (h.isWritablePrimary) { console.log('PRIMARY ready - transactions enabled'); break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await c.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
'@
Push-Location $serverDir
try { node -e $js } finally { Pop-Location }

Write-Host "`nDone. Restart the DukaanSathi server (npm run dev) - it will log 'transactions: on'."
