#NoEnv
#SingleInstance Force
SendMode Input
SetTitleMatchMode, 2
SetWinDelay, -1
#InstallKeybdHook
#InstallMouseHook
; ===== Настройки сетки =====
cols := 10
rows := 3
maxSlots := cols * rows   ; 30
margin := 2
border := 2
gridAlpha := 95
gridColor := "00E5FF"
selected := []
selectedMap := {}
; ===== Work area (без панели задач) =====
SysGet, L, 76
SysGet, T, 77
SysGet, R, 78
SysGet, B, 79
workW := R - L
workH := B - T
cellW := Floor(workW / cols)
cellH := Floor(workH / rows)
; ===== GUI сетки =====
Gui, Grid:New, +AlwaysOnTop -Caption +ToolWindow +E0x20 +LastFound
Gui, Grid:Color, 000001
WinSet, TransColor, 000001 %gridAlpha%
Gui, Grid:Font, s8 Bold, Segoe UI
gridHwnd := ""
Loop, % maxSlots {
    i := A_Index
    col := Mod(i-1, cols)
    row := Floor((i-1) / cols)
    x0 := col * cellW
    y0 := row * cellH
    x := x0 + margin
    y := y0 + margin
    w := cellW - (margin*2)
    h := cellH - (margin*2)
    ; рамка 2px: 4 полосы
    opt := "x" x " y" y " w" w " h" border " Background" gridColor " c" gridColor
    Gui, Grid:Add, Progress, %opt%, 100
    yb := y + h - border
    opt := "x" x " y" yb " w" w " h" border " Background" gridColor " c" gridColor
    Gui, Grid:Add, Progress, %opt%, 100
    opt := "x" x " y" y " w" border " h" h " Background" gridColor " c" gridColor
    Gui, Grid:Add, Progress, %opt%, 100
    xr := x + w - border
    opt := "x" xr " y" y " w" border " h" h " Background" gridColor " c" gridColor
    Gui, Grid:Add, Progress, %opt%, 100
    ; номер зоны
    tx := x + 3
    ty := y + 3
    opt := "x" tx " y" ty " c" gridColor " BackgroundTrans"
    Gui, Grid:Add, Text, %opt%, %i%
}
Gui, Grid:Show, x%L% y%T% w%workW% h%workH% NoActivate, Tile30Grid
WinGet, gridHwnd, ID, Tile30Grid
MsgBox, 64, Tile30, Запущено (AHK v1).`n`nF6 = окно под мышью -> в ячейку (1..30)`nF7 = переложить`nF8 = сброс`nF9 = сетка вкл/выкл
; ===== Хоткеи =====
*F9::ToggleGrid()
*F8::ResetAll()
*F7::RetileAll()
*F6::AddAndTileUnderMouse()
return
ToggleGrid() {
    static visible := true
    if (visible) {
        Gui, Grid:Hide
        visible := false
        ToolTip, Сетка скрыта (F9 показать).
    } else {
        Gui, Grid:Show, NoActivate
        visible := true
        ToolTip, Сетка показана.
    }
    SetTimer, __ttoff, -900
}
ResetAll() {
    global selected, selectedMap, maxSlots
    selected := []
    selectedMap := {}
    ToolTip, Список очищен (F6 добавлять заново).
    SoundBeep, 650, 80
    SetTimer, __ttoff, -1200
}
AddAndTileUnderMouse() {
    global selected, selectedMap, gridHwnd, maxSlots
    MouseGetPos, , , hwnd
    if (!hwnd) {
        ToolTip, Не нашёл окно под мышью.
        SoundBeep, 350, 120
        SetTimer, __ttoff, -1200
        return
    }
    ; если вдруг навели на саму GUI сетки
    if (hwnd = gridHwnd) {
        ToolTip, Наведи на настоящее окно, не на сетку.
        SoundBeep, 350, 120
        SetTimer, __ttoff, -1200
        return
    }
    WinGetClass, cls, ahk_id %hwnd%
    if (cls = "AutoHotkeyGUI") {
        ToolTip, Наведи на настоящее окно (не GUI).
        SoundBeep, 350, 120
        SetTimer, __ttoff, -1200
        return
    }
    ; берём верхнее окно (на случай вложенных hwnd)
    WinGet, top, ID, ahk_id %hwnd%
    if (!top)
        top := hwnd
    if (!selectedMap.HasKey(top)) {
        selectedMap[top] := true
        selected.Push(top)
    }
    cnt := selected.Length()
    if (cnt > maxSlots) {
        ToolTip, Уже выбрано больше %maxSlots%. Нажми F8.
        SoundBeep, 350, 120
        SetTimer, __ttoff, -1500
        return
    }
    TileOne(top, cnt)
    WinGetTitle, title, ahk_id %top%
    ToolTip, Поставлено: %cnt%/%maxSlots%`n%title%
    SoundBeep, 900, 40
    SetTimer, __ttoff, -1200
}
RetileAll() {
    global selected, maxSlots
    cnt := selected.Length()
    if (cnt < 1) {
        ToolTip, Список пуст. Добавляй окна через F6.
        SoundBeep, 350, 120
        SetTimer, __ttoff, -1200
        return
    }
    max := (cnt < maxSlots) ? cnt : maxSlots
    Loop, %max% {
        hwnd := selected[A_Index]
        TileOne(hwnd, A_Index)
    }
    ToolTip, Переложено окон: %max%.
    SoundBeep, 700, 80
    SetTimer, __ttoff, -1200
}
TileOne(hwnd, idx) {
    global cols, rows, L, T, R, B, cellW, cellH, margin
    col := Mod(idx-1, cols)
    row := Floor((idx-1) / cols)
    x0 := L + col * cellW
    y0 := T + row * cellH
    x := x0 + margin
    y := y0 + margin
    if (col = cols-1)
        w := (R - x0) - (margin*2)
    else
        w := cellW - (margin*2)
    if (row = rows-1)
        h := (B - y0) - (margin*2)
    else
        h := cellH - (margin*2)
    WinRestore, ahk_id %hwnd%
    WinMove, ahk_id %hwnd%, , x, y, w, h
}
__ttoff:
ToolTip
return