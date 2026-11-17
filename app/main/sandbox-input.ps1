$ErrorActionPreference='Stop'
$session=$null
try {
  $req=[Console]::In.ReadToEnd() | ConvertFrom-Json
  $vbox=New-Object -ComObject VirtualBox.VirtualBox
  $machine=$vbox.FindMachine([string]$req.id)
  if($machine.GetExtraData('MuseSandboxOwner') -cne [string]$req.owner){throw 'Not a Muse sandbox'}
  $session=New-Object -ComObject VirtualBox.Session
  $machine.LockMachine($session,1)
  $mouse=$session.Console.Mouse
  $x=[int]$req.absoluteX;$y=[int]$req.absoluteY
  if($req.kind -eq 'click') {
    $button=1;if($req.button -eq 'right'){$button=2}
    try {$mouse.PutMouseEventAbsolute($x,$y,0,0,$button)}
    finally {$mouse.PutMouseEventAbsolute($x,$y,0,0,0)}
  } elseif($req.kind -eq 'scroll') {
    $mouse.PutMouseEventAbsolute($x,$y,[int]$req.delta,0,0)
  } else {throw 'Unsupported guest pointer input'}
  @{ok=$true} | ConvertTo-Json -Compress
} catch { @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress }
finally {if($session -and $session.State -eq 1){$session.UnlockMachine()}}
