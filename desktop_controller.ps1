param (
    [string]$Action,
    [int]$X = 0,
    [int]$Y = 0,
    [string]$Text = ""
)

$csharp = @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class DesktopController {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);
    
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);
    
    public const uint MOUSEEVENTF_LEFTDOWN = 0x02;
    public const uint MOUSEEVENTF_LEFTUP = 0x04;
    
    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(50);
        mouse_event(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP, (uint)x, (uint)y, 0, 0);
    }
}
"@

try {
    Add-Type -TypeDefinition $csharp -ReferencedAssemblies "System.Windows.Forms" -ErrorAction SilentlyContinue
} catch {}

if ($Action -eq "click_coordinate") {
    [DesktopController]::Click($X, $Y)
    Write-Output '{"success":true,"status":"Clicked native coordinate"}'
} elseif ($Action -eq "move_cursor") {
    [DesktopController]::SetCursorPos($X, $Y)
    Write-Output '{"success":true,"status":"Moved cursor"}'
} elseif ($Action -eq "type_text") {
    [System.Windows.Forms.SendKeys]::SendWait($Text)
    Write-Output '{"success":true,"status":"Typed text natively"}'
} else {
    Write-Output '{"success":false,"error":"Unknown action"}'
}
