$ErrorActionPreference = 'Stop'
try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class MuseWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)] struct PROCESSENTRY32 {
    public uint dwSize,cntUsage,th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID,cntThreads,th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string szExeFile;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk,wScan; public uint dwFlags,time; public UIntPtr dwExtraInfo; }
  public delegate bool Callback(IntPtr h,IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb,IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a,uint b,bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint f);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count,INPUT[] inputs,int size);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint f,uint p);
  [DllImport("kernel32.dll",CharSet=CharSet.Auto)] static extern bool Process32First(IntPtr h,ref PROCESSENTRY32 p);
  [DllImport("kernel32.dll",CharSet=CharSet.Auto)] static extern bool Process32Next(IntPtr h,ref PROCESSENTRY32 p);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static HashSet<uint> Blocked(uint[] roots) {
    var blocked=new HashSet<uint>(roots); var parents=new Dictionary<uint,uint>();
    IntPtr h=CreateToolhelp32Snapshot(2,0); if(h==new IntPtr(-1)) throw new Exception("Process validation unavailable");
    try { var p=new PROCESSENTRY32(); p.dwSize=(uint)Marshal.SizeOf(p);
      if(!Process32First(h,ref p)) throw new Exception("Process validation unavailable");
      do { parents[p.th32ProcessID]=p.th32ParentProcessID; } while(Process32Next(h,ref p));
    } finally { CloseHandle(h); }
    bool changed=true; while(changed) { changed=false; foreach(var pair in parents) if(blocked.Contains(pair.Value)&&blocked.Add(pair.Key)) changed=true; }
    return blocked;
  }
  public static Dictionary<string,object> Describe(IntPtr h,HashSet<uint> blocked) {
    if(!IsWindow(h)||!IsWindowVisible(h)||IsIconic(h)) throw new Exception("Selected window unavailable or minimized");
    uint pid; GetWindowThreadProcessId(h,out pid); if(blocked.Contains(pid)) throw new Exception("Muse Agent windows cannot be controlled");
    var p=Process.GetProcessById((int)pid); var started=p.StartTime.ToUniversalTime().Ticks.ToString();
    RECT r; if(!GetWindowRect(h,out r)||r.Right<=r.Left||r.Bottom<=r.Top||r.Right-r.Left>16000||r.Bottom-r.Top>16000) throw new Exception("Invalid target bounds");
    var title=new StringBuilder(1024); GetWindowText(h,title,title.Capacity);
    return new Dictionary<string,object>{{"id",h.ToInt64().ToString()},{"pid",(int)pid},{"started",started},{"title",title.ToString()},{"processName",p.ProcessName},{"x",r.Left},{"y",r.Top},{"width",r.Right-r.Left},{"height",r.Bottom-r.Top}};
  }
  public static List<object> List(HashSet<uint> blocked) {
    var list=new List<object>(); EnumWindows((h,p)=>{ try { var w=Describe(h,blocked); if(((string)w["title"]).Length>0&&list.Count<500) list.Add(w); } catch {} return true; },IntPtr.Zero); return list;
  }
  public static void Foreground(IntPtr h) {
    if(GetForegroundWindow()!=h) {
      uint unused; uint foregroundThread=GetWindowThreadProcessId(GetForegroundWindow(),out unused),current=GetCurrentThreadId();
      bool attached=foregroundThread!=current&&AttachThreadInput(current,foregroundThread,true);
      try { BringWindowToTop(h); SetForegroundWindow(h); }
      finally { if(attached) AttachThreadInput(current,foregroundThread,false); }
      System.Threading.Thread.Sleep(80);
    }
    if(GetForegroundWindow()!=h) throw new Exception("Could not activate selected window; activate it and retry");
  }
  public static void Hit(IntPtr h,int x,int y) {
    POINT p=new POINT{X=x,Y=y}; IntPtr hit=WindowFromPoint(p);
    if(GetAncestor(hit,2)!=h) throw new Exception("Another window overlaps the target; reveal the selected window and retry");
  }
  public static void Send(INPUT[] inputs) {
    if(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(INPUT)))!=inputs.Length) throw new Exception("Windows rejected input; check target permissions");
  }
  public static INPUT Key(ushort key,bool up,bool unicode) { return new INPUT{type=1,u=new INPUTUNION{ki=new KEYBDINPUT{wVk=unicode?(ushort)0:key,wScan=unicode?key:(ushort)0,dwFlags=(uint)((up?2:0)|(unicode?4:0))}}}; }
  public static void Type(string text) { var inputs=new List<INPUT>(); foreach(char c in text) { inputs.Add(Key(c,false,true)); inputs.Add(Key(c,true,true)); } Send(inputs.ToArray()); }
  public static void Chord(string chord) {
    var names=new Dictionary<string,ushort>{{"CTRL",17},{"ALT",18},{"SHIFT",16},{"ENTER",13},{"TAB",9},{"ESCAPE",27},{"BACKSPACE",8},{"DELETE",46},{"SPACE",32},{"HOME",36},{"END",35},{"LEFT",37},{"RIGHT",39},{"UP",38},{"DOWN",40},{"PAGEUP",33},{"PAGEDOWN",34}};
    var keys=new List<ushort>(); foreach(var token in chord.Split('+')) { ushort key; if(!names.TryGetValue(token,out key)) key=token.Length==1?(ushort)token[0]:(ushort)(111+int.Parse(token.Substring(1))); keys.Add(key); }
    var inputs=new List<INPUT>(); foreach(var key in keys) inputs.Add(Key(key,false,false)); keys.Reverse(); foreach(var key in keys) inputs.Add(Key(key,true,false)); Send(inputs.ToArray());
  }
  public static void Mouse(string button,int delta) {
    uint down=button=="right"?8u:button=="middle"?32u:2u;
    if(delta!=0) Send(new INPUT[]{new INPUT{type=0,u=new INPUTUNION{mi=new MOUSEINPUT{dwFlags=2048,mouseData=unchecked((uint)delta)}}}});
    else Send(new INPUT[]{new INPUT{type=0,u=new INPUTUNION{mi=new MOUSEINPUT{dwFlags=down}}},new INPUT{type=0,u=new INPUTUNION{mi=new MOUSEINPUT{dwFlags=down*2}}}});
  }
}
'@
  [void][MuseWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
  $blocked = [MuseWindow]::Blocked([uint32[]]$req.blockedPids)
  if ($req.action -eq 'list') { @{ok=$true;windows=@([MuseWindow]::List($blocked))} | ConvertTo-Json -Depth 8 -Compress; exit }
  $h = [IntPtr]::new([long]$req.target.id)
  $w = [MuseWindow]::Describe($h,$blocked)
  if ($w.pid -ne $req.target.pid -or $w.started -cne $req.target.started) { throw 'Selected window identity changed' }
  if ($req.action -eq 'validate') { @{ok=$true} | ConvertTo-Json -Compress; exit }
  if ($req.action -eq 'screenshot') {
    if ([long]$w.width * $w.height -gt 32000000) { throw 'Selected window is too large to capture' }
    $bitmap = New-Object System.Drawing.Bitmap($w.width,$w.height)
    $stream = $null
    try {
      $graphics = [Drawing.Graphics]::FromImage($bitmap)
      try {
        $dc = $graphics.GetHdc()
        try { if (![MuseWindow]::PrintWindow($h,$dc,2)) { throw 'Selected window cannot be captured' } }
        finally { $graphics.ReleaseHdc($dc) }
      } finally { $graphics.Dispose() }
      $stream = New-Object IO.MemoryStream
      $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
      if ($stream.Length -gt 8388608) { throw 'Selected window screenshot exceeds the 8 MiB limit' }
      $data=[Convert]::ToBase64String($stream.ToArray())
    } finally { $bitmap.Dispose(); if ($stream) { $stream.Dispose() } }
    @{ok=$true;window=$w;data=$data} | ConvertTo-Json -Depth 8 -Compress; exit
  }
  foreach ($field in @('x','y','width','height')) { if ($w[$field] -ne $req.args.expectedRect.$field) { throw 'Window moved or resized; take a fresh screenshot' } }
  [MuseWindow]::Foreground($h)
  $w = [MuseWindow]::Describe($h,$blocked)
  if ($w.pid -ne $req.target.pid -or $w.started -cne $req.target.started) { throw 'Selected window identity changed' }
  foreach ($field in @('x','y','width','height')) { if ($w[$field] -ne $req.args.expectedRect.$field) { throw 'Window moved or resized; take a fresh screenshot' } }
  $pointX = $w.x + [int]($w.width/2); $pointY = $w.y + [int]($w.height/2)
  if ($req.action -eq 'click' -or $req.action -eq 'scroll') { $pointX=$w.x+[int]$req.args.x; $pointY=$w.y+[int]$req.args.y }
  [MuseWindow]::Hit($h,$pointX,$pointY)
  if ($req.action -eq 'click' -or $req.action -eq 'scroll') {
    if (![MuseWindow]::SetCursorPos($pointX,$pointY)) { throw 'Could not position the pointer' }
    [MuseWindow]::Hit($h,$pointX,$pointY)
  }
  if ([MuseWindow]::GetForegroundWindow() -ne $h) { throw 'Selected window lost foreground focus' }
  switch ($req.action) {
    'click' { [MuseWindow]::Mouse([string]$req.args.button,0) }
    'scroll' { [MuseWindow]::Mouse('',[int]$req.args.delta) }
    'type' { [MuseWindow]::Type([string]$req.args.text) }
    'key' { [MuseWindow]::Chord([string]$req.args.key) }
    default { throw 'Unknown Windows action' }
  }
  @{ok=$true} | ConvertTo-Json -Compress
} catch { @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress }
