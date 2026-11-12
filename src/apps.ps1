# Lista las apps del menú Inicio con la ruta de su ícono real.
# Salida: JSON [{ name, appId, icon }]. icon es un .png (apps de la Store) o un .exe/.ico (apps de escritorio).
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false  # UTF-8 sin BOM: ñ y acentos bien
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
$ErrorActionPreference = 'SilentlyContinue'

$pkgs = @{}
Get-AppxPackage | ForEach-Object { $pkgs[$_.PackageFamilyName] = $_ }

$lnks = @{}
foreach ($dir in @("$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs")) {
  Get-ChildItem $dir -Recurse -Filter *.lnk | ForEach-Object { if (-not $lnks[$_.BaseName]) { $lnks[$_.BaseName] = $_.FullName } }
}
$shell = New-Object -ComObject WScript.Shell

# De "Assets\Logo.png" elige la variante más nítida que exista (Windows guarda varias escalas).
function Find-Logo($root, $rel) {
  $base = Join-Path $root $rel
  if (Test-Path $base -PathType Leaf) { $exact = $base }
  $dir = Split-Path $base; $stem = [IO.Path]::GetFileNameWithoutExtension($base); $ext = [IO.Path]::GetExtension($base)
  $all = Get-ChildItem $dir -Filter "$stem*$ext" -File
  foreach ($pat in 'altform-unplated_targetsize-48', 'targetsize-48_altform-unplated', 'altform-unplated_targetsize-64', 'targetsize-48', 'targetsize-64', 'scale-200', 'scale-150', 'scale-100') {
    $hit = $all | Where-Object Name -like "*$pat*" | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  if ($exact) { return $exact }
  ($all | Sort-Object Length -Descending | Select-Object -First 1).FullName
}

$out = foreach ($a in Get-StartApps) {
  $icon = $null; $id = $a.AppID
  if ($id -match '^([^\\]+?)!(.+)$' -and $pkgs[$matches[1]]) {
    $p = $pkgs[$matches[1]]; $appKey = $matches[2]
    [xml]$m = Get-Content -Raw (Join-Path $p.InstallLocation 'AppxManifest.xml')
    $app = @($m.Package.Applications.Application) | Where-Object { $_.Id -eq $appKey } | Select-Object -First 1
    $logo = $app.VisualElements.Square44x44Logo
    if (-not $logo) { $logo = $m.Package.Properties.Logo }
    if ($logo) { $icon = Find-Logo $p.InstallLocation $logo }
  } elseif ($lnks[$a.Name]) {
    $sc = $shell.CreateShortcut($lnks[$a.Name])
    $loc = ($sc.IconLocation -split ',')[0]
    $icon = if ($loc) { [Environment]::ExpandEnvironmentVariables($loc) } else { $sc.TargetPath }
    if (-not $icon -or -not (Test-Path $icon)) { $icon = $sc.TargetPath }
    if (-not $icon) { $icon = $lnks[$a.Name] }
  } elseif ($id -match '\.exe$' -and (Test-Path $id)) {
    $icon = $id
  }
  [pscustomobject]@{ name = $a.Name; appId = $id; icon = $icon }
}
$out | Sort-Object name | ConvertTo-Json -Compress
