# Puente con las notificaciones de Windows (llamadas y mensajes).
# stdout: { type:"notif", id, app, appId, title, body, t, logo }  cuando llega una nueva
#         { type:"present", ids:[...] }                           cuando cambia la lista (sirve para saber si una llamada terminó)
#         { type:"denied" }                                       si Windows no da permiso
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, [Type]$t, [int]$ms = 3000) {
  $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op))
  $task.Wait($ms) | Out-Null
  $task.Result
}
function Emit($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }

[Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
$AsStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStream', [Type[]]@([Windows.Storage.Streams.IRandomAccessStream]))
$ListT = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]

$l = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
if ("$($l.GetAccessStatus())" -ne 'Allowed') {
  $r = Await ($l.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]) 15000
  if ("$r" -ne 'Allowed') { Emit @{ type = 'denied' }; Start-Sleep 60; exit }
}

$logos = @{}
function Get-Logo($info) {
  $id = $info.AppUserModelId
  if ($logos.ContainsKey($id)) { return $logos[$id] }
  $url = $null
  try {
    $ref = $info.DisplayInfo.GetLogo([Windows.Foundation.Size]::new(48, 48))
    $s = Await ($ref.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $ms = New-Object System.IO.MemoryStream
    $AsStream.Invoke($null, @($s)).CopyTo($ms)
    $url = 'data:image/png;base64,' + [Convert]::ToBase64String($ms.ToArray())
  } catch {}
  $logos[$id] = $url
  $url
}

$seen = New-Object 'System.Collections.Generic.HashSet[uint32]'
$first = $true
$lastIds = ''

while ($true) {
  $list = Await ($l.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) $ListT
  $ids = @()
  foreach ($n in @($list)) {
    $ids += $n.Id
    if (-not $seen.Add($n.Id)) { continue }
    if ($first) { continue } # las que ya estaban al arrancar no se anuncian
    $b = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
    $texts = @($b.GetTextElements() | ForEach-Object { $_.Text })
    Emit ([ordered]@{
      type  = 'notif'
      id    = $n.Id
      app   = $n.AppInfo.DisplayInfo.DisplayName
      appId = $n.AppInfo.AppUserModelId
      title = if ($texts.Count) { $texts[0] } else { '' }
      body  = if ($texts.Count -gt 1) { ($texts[1..($texts.Count - 1)] -join "`n") } else { '' }
      t     = $n.CreationTime.ToUnixTimeMilliseconds()
      logo  = Get-Logo $n.AppInfo
    })
  }
  $first = $false
  $key = ($ids | Sort-Object) -join ','
  if ($key -ne $lastIds) { $lastIds = $key; Emit @{ type = 'present'; ids = @($ids) } }
  Start-Sleep -Milliseconds 700
}
