"""Compare Windows process integrity before Electron starts. Stdlib only."""
import ctypes as C
from ctypes import wintypes as W
from pathlib import Path

kernel = C.WinDLL('kernel32', use_last_error=True)
advapi = C.WinDLL('advapi32', use_last_error=True)
class StartupInfo(C.Structure):
    _fields_ = [('cb', W.DWORD), ('reserved', W.LPWSTR), ('desktop', W.LPWSTR),
                ('title', W.LPWSTR), ('x', W.DWORD), ('y', W.DWORD),
                ('xsize', W.DWORD), ('ysize', W.DWORD), ('xchars', W.DWORD),
                ('ychars', W.DWORD), ('fill', W.DWORD), ('flags', W.DWORD),
                ('show', W.WORD), ('reserved_size', W.WORD), ('reserved_ptr', C.c_void_p),
                ('stdin', W.HANDLE), ('stdout', W.HANDLE), ('stderr', W.HANDLE)]
class ProcessInfo(C.Structure):
    _fields_ = [('process', W.HANDLE), ('thread', W.HANDLE), ('pid', W.DWORD), ('tid', W.DWORD)]
class SidAttributes(C.Structure):
    _fields_ = [('sid', C.c_void_p), ('attributes', W.DWORD)]
kernel.CreateProcessW.argtypes = [W.LPCWSTR, W.LPWSTR, C.c_void_p, C.c_void_p, W.BOOL,
                                 W.DWORD, C.c_void_p, W.LPCWSTR, C.POINTER(StartupInfo), C.POINTER(ProcessInfo)]
advapi.OpenProcessToken.argtypes = [W.HANDLE, W.DWORD, C.POINTER(W.HANDLE)]
advapi.GetTokenInformation.argtypes = [W.HANDLE, C.c_int, C.c_void_p, W.DWORD, C.POINTER(W.DWORD)]
advapi.ConvertSidToStringSidW.argtypes = [C.c_void_p, C.POINTER(W.LPWSTR)]
kernel.TerminateProcess.argtypes = [W.HANDLE, W.UINT]
kernel.CloseHandle.argtypes = [W.HANDLE]
kernel.LocalFree.argtypes = [C.c_void_p]
root = Path(__file__).resolve().parent.parent
for relative in ['release-verified/win-unpacked/Muse Agent.exe', 'node_modules/electron/dist/electron.exe']:
    executable = str(root / relative)
    startup, process, token = StartupInfo(), ProcessInfo(), W.HANDLE()
    startup.cb = C.sizeof(startup)
    command = C.create_unicode_buffer(f'"{executable}" --version')
    if not kernel.CreateProcessW(executable, command, None, None, False, 4, None, str(root), C.byref(startup), C.byref(process)):
        raise C.WinError(C.get_last_error())
    try:
        if not advapi.OpenProcessToken(process.process, 8, C.byref(token)):
            raise C.WinError(C.get_last_error())
        length = W.DWORD()
        advapi.GetTokenInformation(token, 25, None, 0, C.byref(length))
        buffer = C.create_string_buffer(length.value)
        if not advapi.GetTokenInformation(token, 25, buffer, len(buffer), C.byref(length)):
            raise C.WinError(C.get_last_error())
        label = C.cast(buffer, C.POINTER(SidAttributes)).contents
        text = W.LPWSTR()
        if not advapi.ConvertSidToStringSidW(label.sid, C.byref(text)):
            raise C.WinError(C.get_last_error())
        try:
            print(f'{relative}: integrity={text.value}, pid={process.pid}', flush=True)
        finally:
            kernel.LocalFree(C.cast(text, C.c_void_p))
    finally:
        kernel.TerminateProcess(process.process, 0)
        for handle in [token, process.thread, process.process]:
            if handle:
                kernel.CloseHandle(handle)
