# Puente con Windows SMTC (GlobalSystemMediaTransportControls).
# stdout: una línea JSON por evento.
#   {"type":"state", key, title, artist, app, playing, position, duration, updated}
#   {"type":"thumb", key, data}   <- llega DESPUÉS del state: el título nunca espera a la carátula
# stdin: toggle | next | prev | stop | seek <seconds>
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false  # UTF-8 sin BOM: ñ y acentos bien
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, [Type]$t, [int]$ms = 2000) {
  $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op))
  $task.Wait($ms) | Out-Null
  $task.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
$AsStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStream', [Type[]]@([Windows.Storage.Streams.IRandomAccessStream]))
$MgrT = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$PropsT = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$mgr = Await ($MgrT::RequestAsync()) $MgrT 5000

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

function Read-Thumb($props) {
  try {
    if (-not $props.Thumbnail) { return $null }
    $s = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $net = $AsStream.Invoke($null, @($s))
    $ms = New-Object System.IO.MemoryStream
    $net.CopyTo($ms)
    $mime = if ($s.ContentType) { $s.ContentType } else { 'image/png' }
    return "data:$mime;base64," + [Convert]::ToBase64String($ms.ToArray())
  } catch { return $null }
}

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pending = $stdin.ReadLineAsync()
$cache = @{}          # key -> data uri (volver a una canción anterior es instantáneo)
$lastKey = $null
$lastOut = ''
$sentThumb = ''
$recheck = @()        # SMTC a veces devuelve la carátula ANTERIOR justo después del cambio: reintentamos
$props = $null
$chosen = $null       # app que elegiste a mano con "cycle"; si desaparece, volvemos a la que maneja Windows

function Pick-Session {
  $all = @($mgr.GetSessions())
  if ($script:chosen) {
    $hit = $all | Where-Object { $_.SourceAppUserModelId -eq $script:chosen } | Select-Object -First 1
    if ($hit) { return $hit }
    $script:chosen = $null
  }
  # Windows a veces marca como "actual" una app que no suena (WhatsApp, un video pausado).
  # Si hay alguna reproduciendo, gana esa.
  $cur = $mgr.GetCurrentSession()
  if ($cur -and $cur.GetPlaybackInfo().PlaybackStatus -eq 'Playing') { return $cur }
  $playing = $all | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' } | Select-Object -First 1
  if ($playing) { return $playing }
  $cur
}

while ($true) {
  $s = Pick-Session
  $force = $false

  while ($pending.IsCompleted) {
    if ($null -eq $pending.Result) { exit }
    $parts = "$($pending.Result)".Trim().Split(' ')
    if ($s) {
      switch ($parts[0]) {
        'toggle' { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
        'next'   { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
        'prev'   { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
        'stop'   { $null = Await ($s.TryStopAsync()) ([bool]) }
        'seek'   { $null = Await ($s.TryChangePlaybackPositionAsync([long]([double]::Parse($parts[1], [Globalization.CultureInfo]::InvariantCulture) * 10000000))) ([bool]) }
        'cycle'  {
          $ids = @($mgr.GetSessions() | ForEach-Object { $_.SourceAppUserModelId })
          if ($ids.Count -gt 1) { $script:chosen = $ids[([array]::IndexOf($ids, $s.SourceAppUserModelId) + 1) % $ids.Count] }
          $s = Pick-Session
        }
      }
    }
    $force = $true
    $pending = $stdin.ReadLineAsync()
  }

  if ($s) {
    $props = Await ($s.TryGetMediaPropertiesAsync()) $PropsT
    $info = $s.GetPlaybackInfo()
    $tl = $s.GetTimelineProperties()
    $key = "$($s.SourceAppUserModelId)|$($props.Title)|$($props.Artist)"
    $state = [ordered]@{
      type     = 'state'
      active   = $true
      key      = $key
      app      = $s.SourceAppUserModelId
      title    = $props.Title
      artist   = $props.Artist
      playing  = ($info.PlaybackStatus -eq 'Playing')
      position = [math]::Round($tl.Position.TotalSeconds, 2)
      duration = [math]::Round($tl.EndTime.TotalSeconds, 2)
      updated  = $tl.LastUpdatedTime.ToUnixTimeMilliseconds()
      sessions = @($mgr.GetSessions() | ForEach-Object { $_.SourceAppUserModelId })
    }
  } else {
    $key = ''
    $state = [ordered]@{ type = 'state'; active = $false; key = '' }
  }

  $json = $state | ConvertTo-Json -Compress
  if ($force -or $json -ne $lastOut) { $lastOut = $json; [Console]::Out.WriteLine($json); [Console]::Out.Flush() }

  if ($key -ne $lastKey) {
    $lastKey = $key
    $sentThumb = ''
    if ($key -and $cache.ContainsKey($key)) {
      $sentThumb = $cache[$key]
      Emit @{ type = 'thumb'; key = $key; data = $sentThumb }
    }
    $now = [Environment]::TickCount
    $recheck = if ($key) { @($now, ($now + 900), ($now + 2500)) } else { @() }
  }

  if ($recheck.Count -and [Environment]::TickCount -ge $recheck[0]) {
    $recheck = @($recheck | Select-Object -Skip 1)
    $t = Read-Thumb $props
    if (-not $t -and -not $sentThumb -and $nullSentFor -ne $key) {
      $nullSentFor = $key   # la app no tiene carátula: avisamos para que no quede la anterior borrosa
      Emit @{ type = 'thumb'; key = $key; data = $null }
    }
    if ($t -and $t -ne $sentThumb) {
      $sentThumb = $t
      $cache[$key] = $t
      if ($cache.Count -gt 60) { $cache.Remove(($cache.Keys | Select-Object -First 1)) }
      Emit @{ type = 'thumb'; key = $key; data = $t }
    }
  }

  Start-Sleep -Milliseconds 120
}
