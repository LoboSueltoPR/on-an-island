# Puente con el sistema: volumen, batería, app en primer plano, pantalla completa y portapapeles.
# stdout: una línea JSON cada vez que algo cambia.
#   { fg, fgName, fgPath, fs, vol, mute, bat, pct, ac, seq }
# stdin: vol <0..1> | mute
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr p); int UnregisterControlChangeNotify(IntPtr p);
  int GetChannelCount(out int c); int SetMasterVolumeLevel(float l, Guid g);
  int SetMasterVolumeLevelScalar(float l, Guid g); int GetMasterVolumeLevel(out float l);
  int GetMasterVolumeLevelScalar(out float l);
  int SetChannelVolumeLevel(uint n, float l, Guid g); int SetChannelVolumeLevelScalar(uint n, float l, Guid g);
  int GetChannelVolumeLevel(uint n, out float l); int GetChannelVolumeLevelScalar(uint n, out float l);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, Guid g); int GetMute(out bool m);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int p, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int NotImpl1(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }

public static class IslaSys {
  static IAudioEndpointVolume Epv() {
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev; Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume epv; Guid iid = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, 0, out epv));
    return epv;
  }
  public static float Volume() { try { float v; Epv().GetMasterVolumeLevelScalar(out v); return v; } catch { return -1; } }
  public static bool Muted() { try { bool m; Epv().GetMute(out m); return m; } catch { return false; } }
  public static void SetVolume(float v) {
    try { var e = Epv(); e.SetMute(false, Guid.Empty); e.SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, v)), Guid.Empty); } catch { }
  }
  public static void ToggleMute() { try { var e = Epv(); bool m; e.GetMute(out m); e.SetMute(!m, Guid.Empty); } catch { } }

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();

  public static uint ForegroundPid() { uint p; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
  public static bool Fullscreen() {
    IntPtr h = GetForegroundWindow(); if (h == IntPtr.Zero) return false;
    var sb = new StringBuilder(64); GetClassName(h, sb, 64); string c = sb.ToString();
    if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd") return false;
    RECT r; if (!GetWindowRect(h, out r)) return false;
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(mi);
    if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return false;
    return r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B;
  }
}
'@

# Qué apps están usando el micrófono o la cámara ahora (Windows lo anota en el registro).
function Get-InUse($cap) {
  $out = New-Object System.Collections.Generic.List[string]
  Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\$cap" -Recurse | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    if ($p.LastUsedTimeStart -and $p.LastUsedTimeStop -eq 0) {
      $n = $_.PSChildName
      $n = if ($n -match '#') { [IO.Path]::GetFileNameWithoutExtension(($n -split '#')[-1]) } else { ($n -split '_')[0].Split('.')[-1] }
      if (-not $out.Contains($n)) { $out.Add($n) }
    }
  }
  , @($out | Sort-Object)
}

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pending = $stdin.ReadLineAsync()
$procs = @{}   # pid -> info de la app (se cachea: Get-Process es caro)
$last = ''
$tickN = 0
$mic = @(); $cam = @()

while ($true) {
  while ($pending.IsCompleted) {
    if ($null -eq $pending.Result) { exit }
    $parts = "$($pending.Result)".Trim().Split(' ')
    switch ($parts[0]) {
      'vol'  { [IslaSys]::SetVolume([float]::Parse($parts[1], [Globalization.CultureInfo]::InvariantCulture)) }
      'mute' { [IslaSys]::ToggleMute() }
    }
    $pending = $stdin.ReadLineAsync()
  }

  $fpid = [IslaSys]::ForegroundPid()
  $info = $procs[$fpid]
  if (-not $info) {
    $p = Get-Process -Id $fpid
    $desc = $p.MainModule.FileVersionInfo.FileDescription
    if (-not $desc) { $desc = $p.ProcessName }
    $info = @{ name = $p.ProcessName; desc = $desc; path = $p.Path }
    $procs[$fpid] = $info
    if ($procs.Count -gt 200) { $procs.Clear() }
  }
  if ($tickN++ % 5 -eq 0) { $mic = Get-InUse 'microphone'; $cam = Get-InUse 'webcam' }
  $ps = [System.Windows.Forms.SystemInformation]::PowerStatus
  $state = [ordered]@{
    fg     = $info.name
    fgName = $info.desc
    fgPath = $info.path
    fs     = [IslaSys]::Fullscreen()
    vol    = [int][math]::Round([IslaSys]::Volume() * 100)
    mute   = [IslaSys]::Muted()
    bat    = -not ([int]$ps.BatteryChargeStatus -band 128)
    pct    = [int][math]::Round($ps.BatteryLifePercent * 100)
    ac     = ($ps.PowerLineStatus -eq 'Online')
    seq    = [IslaSys]::GetClipboardSequenceNumber()
    mic    = $mic
    cam    = $cam
  }
  $json = $state | ConvertTo-Json -Compress
  if ($json -ne $last) { $last = $json; [Console]::Out.WriteLine($json); [Console]::Out.Flush() }
  Start-Sleep -Milliseconds 200
}
