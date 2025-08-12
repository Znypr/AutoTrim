import sys

if sys.platform == "win32":
    try:
        import comtypes.client as cc  # type: ignore

        class TaskbarProgress:
            """Windows taskbar progress indicator."""

            TBPF_NOPROGRESS = 0
            TBPF_INDETERMINATE = 0x1
            TBPF_NORMAL = 0x2

            def __init__(self, hwnd: int):
                self.hwnd = hwnd
                self._tb = cc.CreateObject("TaskbarList")
                self._tb.HrInit()

            def indeterminate(self) -> None:
                self._tb.SetProgressState(self.hwnd, self.TBPF_INDETERMINATE)

            def set(self, completed: int, total: int) -> None:
                self._tb.SetProgressState(self.hwnd, self.TBPF_NORMAL)
                self._tb.SetProgressValue(self.hwnd, int(completed), int(total))

            def clear(self) -> None:
                self._tb.SetProgressState(self.hwnd, self.TBPF_NOPROGRESS)

    except Exception:
        class TaskbarProgress:  # type: ignore
            def __init__(self, *_: object) -> None:
                pass
            def indeterminate(self) -> None:
                pass
            def set(self, *_: object) -> None:
                pass
            def clear(self) -> None:
                pass
else:
    class TaskbarProgress:  # type: ignore
        def __init__(self, *_: object) -> None:
            pass
        def indeterminate(self) -> None:
            pass
        def set(self, *_: object) -> None:
            pass
        def clear(self) -> None:
            pass
